import fs from "node:fs";
import path from "node:path";
import { createProviderAdapters } from "./adapters/index.js";
import { evidenceText, retrieveEvidence } from "./rag.js";
import { normalizeOrchestratorOutput, validateOrchestratorOutput } from "./orchestratorContract.js";
import { setupProposalPrompt, setupVotePrompt, studentSimulationPrompt } from "./prompts.js";
import { parseModelSpec, sha256 } from "./util.js";
import { mapPool } from "../concurrency.js";

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function totalCost(calls) {
    return calls.reduce((sum, call) => sum + Number(call.cost_estimated_usd || 0), 0);
}

function recordCall(calls, { role, spec, caseId, turnId, call }) {
    calls.push({
        call_id: `generation-call-${String(calls.length + 1).padStart(6, "0")}`,
        role, provider: spec.provider, model: spec.model, effort: spec.effort,
        case_id: caseId, turn_id: turnId, request: call.request, response: call.response,
        request_hash: sha256(call.request || {}), response_hash: sha256(call.response || {}),
        usage: call.usage || {}, latency_ms: call.latency_ms,
        cost_estimated_usd: call.cost?.cost_usd ?? null,
        cost_source: call.cost?.cost_source || "unavailable",
    });
}

function retryPrompt(prompt, attempt, errors) {
    if (!attempt) return prompt;
    return `${prompt}\n\nCORRECAO OBRIGATORIA DA TENTATIVA ANTERIOR:\n${errors.join("; ")}\nRetorne novamente o objeto completo, corrigindo esses erros sem omitir campos.`;
}

function selectCanonical(proposals, votes, scenario) {
    const counts = new Map(proposals.map((proposal) => [proposal.id, 0]));
    for (const vote of votes) if (counts.has(vote.selected_proposal_id)) counts.set(vote.selected_proposal_id, counts.get(vote.selected_proposal_id) + 1);
    const selected = [...proposals].sort((a, b) => (counts.get(b.id) - counts.get(a.id)) || a.id.localeCompare(b.id))[0];
    const threshold = Math.max(1, Math.ceil(votes.length / 2));
    const kindVotes = (field, minVotes) => {
        const values = new Map();
        for (const vote of votes) for (const kind of vote[field] || []) values.set(kind, (values.get(kind) || 0) + 1);
        return [...values].filter(([, count]) => count >= minVotes).map(([kind]) => kind).sort();
    };
    // Aceitável = UNIÃO dos votos (basta 1 conselheiro defender o tipo);
    // proibido segue exigindo MAIORIA. Com exigência de maioria no aceitável,
    // o conjunto degenerava no singleton da ação preferida — e "Ação Aceitável"
    // virava "acertou exatamente o gabarito" (observado no run S0: taxa
    // aceitável == taxa preferida em todos os candidatos).
    const acceptableKinds = kindVotes("acceptable_kinds", 1);
    if (!acceptableKinds.includes(selected.output.action.kind)) acceptableKinds.push(selected.output.action.kind);
    return {
        output: selected.output,
        policy: {
            preferred_kind: selected.output.action.kind,
            acceptable_kinds: acceptableKinds.sort(),
            forbidden_kinds: kindVotes("forbidden_kinds", threshold).filter((kind) => !acceptableKinds.includes(kind)),
            required_action_fields: scenario.required_action_fields || {},
        },
        selected_proposal_id: selected.id,
        proposal_vote_counts: Object.fromEntries(counts),
        proposals,
        votes,
        expected_intents: scenario.expected_intents || [],
        known_risks: scenario.known_risks || [],
    };
}

export async function generateCanonicalSetup({
    key, cases, council, config, artifactDir, adapters = {}, onProgress = null, signal = null,
}) {
    if (!Array.isArray(council) || !council.length) throw new Error("conselho do setup vazio");
    const specs = council.map(parseModelSpec);
    const providerAdapters = createProviderAdapters(specs, config, adapters);
    const simulator = specs[0];
    const calls = [];
    const generatedCases = [];
    const maxCost = Number(config.limits?.max_cost_usd ?? 50);
    const maxCalls = Math.max(1, Number(config.limits?.max_calls || 250));
    const semanticAttempts = 1 + Math.max(0, Math.min(2, Number(config.limits?.retries || 0)));
    // Um erro em qualquer caso aborta o lote: casos em voo terminam o passo
    // corrente, nenhum novo começa, e o erro original é relançado.
    let abortError = null;
    const assertActive = () => {
        if (abortError) throw abortError;
        if (signal?.aborted) throw Object.assign(new Error("geracao cancelada"), { code: "BENCH_CANCELLED" });
        if (calls.length >= maxCalls) throw new Error(`limite de chamadas da geracao atingido: ${maxCalls}`);
        if (totalCost(calls) >= maxCost) throw new Error(`limite de custo da geracao atingido: US$ ${totalCost(calls).toFixed(4)}`);
    };
    const progress = async (detail) => { if (onProgress) await onProgress({ calls: calls.length, cost_usd: totalCost(calls), ...detail }); };

    ensureDir(artifactDir);
    try {
    // Dentro de um caso a geração é inerentemente sequencial (o turno N+1
    // depende do canônico do turno N); entre casos não há dependência.
    const generateCase = async (testCase) => {
        let history = [];
        let interviewerMessage = testCase.interview_plan.opening_question;
        let memoryBefore = { questions_covered: [], questions_skipped: [], open_threads: [], free_notes: "" };
        const turns = [];
        for (const studentState of testCase.student_states) {
            assertActive();
            const studentPrompt = studentSimulationPrompt(testCase, studentState, history, interviewerMessage, config.prompts || {});
            let studentCall;
            for (let attempt = 0; attempt < semanticAttempts; attempt++) {
                assertActive();
                const prompt = retryPrompt(studentPrompt, attempt, ["message deve ser uma string nao vazia"]);
                studentCall = await providerAdapters[simulator.provider].generateStudentReply({ spec: simulator, prompt });
                recordCall(calls, { role: attempt ? "student_simulator_retry" : "student_simulator", spec: simulator, caseId: testCase.id, turnId: studentState.id, call: studentCall });
                await progress({ case_id: testCase.id, turn_id: studentState.id, phase: "student" });
                if (String(studentCall.parsed?.message || "").trim()) break;
            }
            const studentMessage = String(studentCall.parsed?.message || "").trim();
            if (!studentMessage) throw new Error(`${testCase.id}/${studentState.id}: simulador retornou fala vazia`);
            const turn = {
                id: studentState.id,
                history: [...history, { role: "interviewer", text: interviewerMessage }],
                student_message: studentMessage,
                objective_id: studentState.objective_id,
                responds_to: studentState.responds_to,
                student_behavior: studentState.behavior,
                behavior_observed: studentCall.parsed?.behavior_observed || "",
                input_metadata: studentState.input_metadata || { channel: "text", transcript_confidence: 1 },
                memory_before: memoryBefore,
            };
            const evidence = retrieveEvidence(testCase, turn, config.rag || {});
            const sharedEvidence = evidenceText(evidence);
            const proposals = [];
            for (const [index, spec] of specs.entries()) {
                assertActive();
                const prompt = setupProposalPrompt(testCase, studentState, turn, sharedEvidence, config.prompts || {});
                let call; let validation;
                for (let attempt = 0; attempt < semanticAttempts; attempt++) {
                    assertActive();
                    const attemptPrompt = retryPrompt(prompt, attempt, validation?.errors || []);
                    call = await providerAdapters[spec.provider].generateSetupProposal({ spec, prompt: attemptPrompt });
                    recordCall(calls, { role: attempt ? "setup_proposal_retry" : "setup_proposal", spec, caseId: testCase.id, turnId: studentState.id, call });
                    validation = validateOrchestratorOutput(call.parsed);
                    await progress({ case_id: testCase.id, turn_id: studentState.id, phase: "proposals" });
                    if (validation.valid) break;
                }
                if (!validation.valid) throw new Error(`${testCase.id}/${studentState.id}: proposta invalida de ${spec.key} apos ${semanticAttempts} tentativas: ${validation.errors.join("; ")}`);
                proposals.push({ id: `P${index + 1}`, model_key: spec.key, output: validation.normalized });
            }
            const votes = [];
            for (const spec of specs) {
                assertActive();
                const prompt = setupVotePrompt(testCase, studentState, turn, sharedEvidence, proposals, config.prompts || {});
                let call;
                let voteErrors = ["voto ausente ou selected_proposal_id nao corresponde a uma proposta"];
                for (let attempt = 0; attempt < semanticAttempts; attempt++) {
                    assertActive();
                    const attemptPrompt = retryPrompt(prompt, attempt, voteErrors);
                    call = await providerAdapters[spec.provider].voteSetup({ spec, prompt: attemptPrompt });
                    recordCall(calls, { role: attempt ? "setup_vote_retry" : "setup_vote", spec, caseId: testCase.id, turnId: studentState.id, call });
                    await progress({ case_id: testCase.id, turn_id: studentState.id, phase: "votes" });
                    if (call.parsed && proposals.some((proposal) => proposal.id === call.parsed.selected_proposal_id)) break;
                    voteErrors = [`selected_proposal_id deve ser um destes valores: ${proposals.map((proposal) => proposal.id).join(", ")}`];
                }
                if (!call.parsed || !proposals.some((proposal) => proposal.id === call.parsed.selected_proposal_id)) throw new Error(`${testCase.id}/${studentState.id}: voto invalido de ${spec.key} apos ${semanticAttempts} tentativas`);
                votes.push({ model_key: spec.key, ...call.parsed });
            }
            const canonical = selectCanonical(proposals, votes, studentState);
            if (!studentState.expected_action_kinds.includes(canonical.output.action.kind)) {
                throw new Error(`${testCase.id}/${studentState.id}: conselho selecionou ${canonical.output.action.kind}, incompatível com a continuação planejada (${studentState.expected_action_kinds.join(", ")})`);
            }
            turns.push({ ...turn, rag: evidence, canonical });
            history = [...turn.history, { role: "student", text: studentMessage }];
            interviewerMessage = canonical.output.action.message;
            memoryBefore = normalizeOrchestratorOutput(canonical.output).memory;
        }
        const generated = { ...testCase, turns };
        generatedCases.push(generated); // parcial de falha: ordem de término
        return generated;
    };

    const concurrency = Math.max(1, Math.floor(Number(config.limits?.max_concurrency)) || 1);
    const caseResults = await mapPool(cases, concurrency, async (testCase) => {
        if (abortError) return null;
        try { return await generateCase(testCase); }
        catch (err) { if (!abortError) abortError = err; return null; }
    });
    if (abortError) throw abortError;
    // Ordem de ENTRADA (mapPool preserva), não de término: cases_hash é
    // sensível à ordem e precisa ser reprodutível sob concorrência.
    const orderedCases = caseResults.map((r) => (r.ok ? r.value : null)).filter(Boolean);

    const result = {
        schema_version: 3,
        cases: orderedCases,
        setup_config: config.setup_config || {},
        provenance: {
            mode: "llm_council",
            generation_key: key,
            generated_at: new Date().toISOString(),
            council,
            calls: calls.length,
            known_cost_usd: totalCost(calls),
            cases_hash: sha256(orderedCases),
        },
        calls,
    };
    writeJson(path.join(artifactDir, "manifest.generated.json"), result);
    writeJson(path.join(artifactDir, "calls.json"), calls);
    return result;
    } catch (err) {
        const partial = {
            schema_version: 3,
            generation_key: key,
            failed_at: new Date().toISOString(),
            error: String(err?.stack || err?.message || err),
            completed_cases: generatedCases,
            calls,
            known_cost_usd: totalCost(calls),
        };
        try {
            writeJson(path.join(artifactDir, "failure.partial.json"), partial);
            writeJson(path.join(artifactDir, "calls.partial.json"), calls);
        } catch { /* O erro original tem prioridade. */ }
        err.generationCalls = calls;
        err.knownCostUsd = totalCost(calls);
        err.progress = { calls: calls.length, cost_usd: totalCost(calls) };
        throw err;
    }
}

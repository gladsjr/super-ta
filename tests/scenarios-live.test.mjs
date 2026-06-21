// Testes da Fase 0 do sistema multiagente — SEM TOKEN (zero LLM).
//
// Cobre: renderização da agenda/briefing (golden), validação do schema de ação,
// guardrails do liveEngine com um agente STUB, e um smoke do mockEngine.
// Rodar: node tests/scenarios-live.test.mjs

import { SEED_SCENARIOS } from "../lib/scenarios/seed.js";
import { renderPersonaAgenda, renderInteractionBriefing } from "../lib/scenarios/agenda.js";
import { validateScenarioTurn, validatePersonaExchange } from "../lib/scenarios/scenarioActionSchema.js";
import {
    interactionStartLive, respondLive, buildRunMemory, studentTurnsInCurrent,
    MAX_STUDENT_TURNS_PER_INTERACTION,
} from "../lib/scenarios/liveEngine.js";
import { interactionStart as mockStart, respond as mockRespond, interactionHeader, scenarioFrame } from "../lib/scenarios/mockEngine.js";
import { resolveSpeaker } from "../agents/ScenarioOrchestratorAgent.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("  ✗ FAIL:", msg); } };
const section = t => console.log(`\n# ${t}`);

const scenario = SEED_SCENARIOS[0];
const personasById = Object.fromEntries(scenario.personas.map(p => [p.id, p]));
const [iAbertura, iArguicao, iDelib, iFinal] = scenario.interactions;
const marcos = personasById["cp_marcos"], ana = personasById["cp_ana"];

// ---- 1. Agenda / briefing (golden) ----
section("agenda da persona");
const ag = renderPersonaAgenda(marcos);
ok(ag.includes("investidor anjo cético"), "agenda inclui o papel");
ok(ag.includes("achar o ponto fraco do plano"), "agenda inclui um objetivo");
ok(ag.includes("direto, impaciente"), "agenda inclui o tom");
ok(!/\{\{\w+\}\}/.test(ag), "agenda não deixou placeholder por preencher");

section("briefing da interação");
const brief = renderInteractionBriefing({ scenario, interaction: iArguicao, personasById, position: 2, total: 4 });
ok(brief.includes("Banca de investidores"), "briefing inclui o nome do cenário");
ok(brief.includes("etapa 2 de 4"), "briefing inclui a posição na sequência");
ok(brief.includes("DINÂMICA DESTA INTERAÇÃO"), "briefing traz o bloco de dinâmica (camada da forma)");
ok(brief.includes("NEGOCIAM"), "briefing traz a dinâmica da forma derivada (negociação)");
ok(brief.includes("MATERIAIS DISPONÍVEIS"), "briefing traz o bloco de materiais");
ok(brief.includes("Marcos") && brief.includes("Ana"), "briefing inclui as duas personas");
ok(brief.includes("Responda às perguntas dos dois investidores"), "briefing inclui a instrução");
ok(!/\{\{\w+\}\}/.test(brief), "briefing não deixou placeholder por preencher");

const briefEx = renderInteractionBriefing({ scenario, interaction: iDelib, personasById, position: 3, total: 4 });
ok(briefEx.includes("Foco da conversa entre as personas"), "briefing de persona_exchange traz o foco");

section("briefing: regras do cenário (escopo/premissas) e tempo");
const briefRules = renderInteractionBriefing({
    scenario: { name: "S", description: "d", out_of_scope: "salário; política", premissas: "orçamento aprovado" },
    interaction: { ...iArguicao, time_limit_min: 12 }, personasById, position: 1, total: 1,
});
ok(briefRules.includes("REGRAS DO CENÁRIO"), "briefing traz o bloco de regras quando há escopo/premissas");
ok(briefRules.includes("FORA DO ESCOPO") && briefRules.includes("salário; política"), "briefing inclui os tópicos fora do escopo");
ok(briefRules.includes("PREMISSAS") && briefRules.includes("orçamento aprovado"), "briefing inclui as premissas");
ok(briefRules.includes("TEMPO DESTA ETAPA") && briefRules.includes("12 minuto"), "briefing menciona o tempo da etapa");
ok(!/\{\{\w+\}\}/.test(briefRules), "briefing com regras/tempo não deixou placeholder");
const briefNoRules = renderInteractionBriefing({ scenario: { name: "S", description: "d" }, interaction: iArguicao, personasById, position: 1, total: 1 });
ok(!briefNoRules.includes("REGRAS DO CENÁRIO"), "sem escopo/premissas, o bloco de regras some");
ok(!briefNoRules.includes("TEMPO DESTA ETAPA"), "sem time_limit, o bloco de tempo some");

// ---- 2. Schema de ação ----
section("validateScenarioTurn");
const allow = ["cp_marcos", "cp_ana"];
ok(validateScenarioTurn({ speaker_persona_id: "cp_marcos", action: { kind: "speak", message: "oi" }, rationale: "r" }, allow).valid, "turn válido");
ok(!validateScenarioTurn({ speaker_persona_id: "x", action: { kind: "speak", message: "oi" }, rationale: "r" }, allow).valid, "falante fora dos participantes é inválido");
ok(!validateScenarioTurn({ speaker_persona_id: "cp_marcos", action: { kind: "speak", message: "" }, rationale: "r" }, allow).valid, "speak sem message é inválido");
ok(validateScenarioTurn({ speaker_persona_id: "cp_marcos", action: { kind: "advance", message: "" }, rationale: "r" }, allow).valid, "advance sem message é válido");
ok(!validateScenarioTurn({ speaker_persona_id: "cp_marcos", action: { kind: "speak", message: "oi" } }, allow).valid, "sem rationale é inválido");
ok(validateScenarioTurn({ speaker_persona_id: "cp_marcos", action: { kind: "speak", message: "oi", hint: { title: "Fora do escopo", body: "esse tema não faz parte do cenário" } }, rationale: "r" }, allow).valid, "speak com hint válido");
ok(!validateScenarioTurn({ speaker_persona_id: "cp_marcos", action: { kind: "speak", message: "oi", hint: { title: "x", body: "" } }, rationale: "r" }, allow).valid, "hint com body vazio é inválido");
ok(validateScenarioTurn({ speaker_persona_id: "cp_marcos", action: { kind: "speak", message: "oi", hint: null }, rationale: "r" }, allow).valid, "hint null é ignorado (válido)");

section("validatePersonaExchange");
ok(validatePersonaExchange({ lines: [{ speaker_persona_id: "cp_marcos", message: "a" }, { speaker_persona_id: "cp_ana", message: "b" }], rationale: "r" }, allow).valid, "exchange válido");
ok(!validatePersonaExchange({ lines: [{ speaker_persona_id: "zzz", message: "a" }], rationale: "r" }, allow).valid, "line com falante inválido reprova");
ok(!validatePersonaExchange({ lines: [], rationale: "r" }, allow).valid, "lines vazio reprova");

// ---- 3. liveEngine com agente STUB ----
const stub = {
    interactionOpener: async ({ interaction }) => ({ speaker_persona_id: interaction.opener_persona_id, action: { kind: "speak", message: "STUB abertura" }, rationale: "r", memory: {} }),
    studentTurn: async ({ interaction }) => ({ speaker_persona_id: interaction.participants[0].persona_id, action: { kind: "speak", message: "STUB resposta" }, rationale: "r", memory: { free_notes: "n" } }),
    personaExchange: async ({ interaction }) => ({ lines: interaction.participants.map(p => ({ speaker_persona_id: p.persona_id, message: `STUB ${p.persona_id}` })), rationale: "r" }),
};
const badSpeakerStub = { ...stub, studentTurn: async () => ({ speaker_persona_id: "inexistente", action: { kind: "speak", message: "x" }, rationale: "r" }) };

section("interactionStartLive (student)");
const startS = await interactionStartLive(stub, { scenario, interaction: iAbertura, personasById, idx: 0, total: 4 });
ok(startS[0].kind === "interaction", "1ª entrada é o cabeçalho (kind=interaction)");
ok(startS[0].it_kind === "student", "cabeçalho carrega it_kind=student");
ok(startS[1].kind === "persona" && startS[1].name === "Marcos", "abertura é fala de persona (Marcos)");
ok(startS[1].text === "STUB abertura", "fala da abertura veio do agente");

section("interactionStartLive (persona_exchange)");
const startEx = await interactionStartLive(stub, { scenario, interaction: iDelib, personasById, idx: 2, total: 4 });
ok(startEx[0].kind === "interaction", "exchange: cabeçalho presente");
ok(startEx.slice(1).every(e => e.kind === "aside"), "exchange: demais entradas são asides");
ok(startEx[1].to && startEx[1].to !== startEx[1].speaker, "aside aponta para a OUTRA persona (to)");

section("respondLive (turno do aluno)");
const tr = [scenarioFrame(scenario), interactionHeader(iArguicao, personasById, 1, 4), { speaker: "student", kind: "student", text: "minha resposta" }];
const r1 = await respondLive(stub, { scenario, interaction: iArguicao, personasById, idx: 1, total: 4, transcript: tr });
ok(r1.entries.length === 1 && r1.entries[0].kind === "persona" && r1.entries[0].name === "Marcos", "respondLive devolve fala de persona");
ok(r1.action.kind === "speak", "respondLive propaga a ação do agente");

section("guardrail: falante inválido cai no 1º participante");
const rBad = await respondLive(badSpeakerStub, { scenario, interaction: iArguicao, personasById, idx: 1, total: 4, transcript: tr });
ok(rBad.entries[0].name === "Marcos", "fallback do falante para o 1º participante");

section("guardrail: teto de turnos força advance");
const capped = [interactionHeader(iArguicao, personasById, 1, 4)];
for (let i = 0; i < MAX_STUDENT_TURNS_PER_INTERACTION; i++) capped.push({ speaker: "student", kind: "student", text: `t${i}` });
ok(studentTurnsInCurrent(capped) === MAX_STUDENT_TURNS_PER_INTERACTION, "contagem de turnos do aluno");
let agentCalled = false;
const spyStub = { ...stub, studentTurn: async () => { agentCalled = true; return stub.studentTurn({ interaction: iArguicao }); } };
const rCap = await respondLive(spyStub, { scenario, interaction: iArguicao, personasById, idx: 1, total: 4, transcript: capped });
ok(rCap.action.kind === "advance" && rCap.capped === true, "teto força advance");
ok(agentCalled === false, "no teto, nem chama o agente (economia)");

section("buildRunMemory (determinístico)");
const trMem = [
    scenarioFrame(scenario),
    interactionHeader(iAbertura, personasById, 0, 4),
    { speaker: "student", kind: "student", text: "resolvo X para PMEs" },
    interactionHeader(iArguicao, personasById, 1, 4),
];
const mem = buildRunMemory(scenario, trMem, 1);
ok(mem.includes("Abertura com o investidor-líder"), "memória cita o título da interação anterior");
ok(mem.includes("resolvo X para PMEs"), "memória cita a fala do aluno");

// ---- 4. Smoke do mockEngine (continua intacto) ----
section("mockEngine smoke");
const ms = mockStart(iAbertura, personasById, 0, 4);
ok(ms[0].kind === "interaction" && ms[0].it_kind === "student", "mock: cabeçalho com kind/it_kind corretos");
ok(ms[1].kind === "persona", "mock: abertura é fala de persona");
const mr = mockRespond(iArguicao, personasById, [interactionHeader(iArguicao, personasById, 1, 4), { kind: "student", text: "oi" }], "oi");
ok(mr.length === 1 && mr[0].kind === "persona", "mock: respond devolve fala de persona");

// ---- 5. Fronteiras estruturais (sem token) ----
section("resolveSpeaker (normalização nome→id, fallback)");
const trio = { cp_marcos: marcos, cp_ana: ana, cp_bia: { id: "cp_bia", name: "Bia", icon: "📰", role: "repórter", objectives: [], concerns: [], knowledge: {} } };
const allow3 = ["cp_marcos", "cp_ana", "cp_bia"];
const it3 = { id: "x", title: "Trio", kind: "student", objective_type: "discussao", participants: allow3.map((id, i) => ({ persona_id: id, role: ["questionamento", "discussao", "questionamento"][i] })), opener_persona_id: "cp_marcos", focus: "" };
ok(resolveSpeaker("cp_ana", allow3, trio, it3) === "cp_ana", "id exato passa");
ok(resolveSpeaker("Ana", allow3, trio, it3) === "cp_ana", "nome→id");
ok(resolveSpeaker("Bia", allow3, trio, it3) === "cp_bia", "nome→id (3º participante)");
ok(resolveSpeaker("ninguém", allow3, trio, it3) === "cp_marcos", "desconhecido cai no opener");
ok(resolveSpeaker("", allow3, trio, it3) === "cp_marcos", "vazio cai no opener");
ok(resolveSpeaker(null, allow3, trio, it3) === "cp_marcos", "null cai no opener");

section("briefing com 3 participantes (aluno↔N)");
const b3 = renderInteractionBriefing({ scenario: { name: "Mesa", description: "" }, interaction: it3, personasById: trio, position: 1, total: 1 });
ok(b3.includes("Marcos") && b3.includes("Ana") && b3.includes("Bia"), "briefing lista as 3 personas");
ok((b3.match(/id: `cp_/g) || []).length === 3, "briefing mostra os 3 ids");

section("persona_exchange como 1ª interação (memória de run vazia)");
ok(buildRunMemory(scenario, [scenarioFrame(scenario)], 0) === "", "buildRunMemory vazio antes da 1ª interação");
const bx = renderInteractionBriefing({ scenario, interaction: iDelib, personasById, position: 1, total: 1, runMemory: "" });
ok(bx.includes("primeira interação"), "briefing trata memória vazia");

// ---- resumo ----
console.log(`\n${fail === 0 ? "✓" : "✗"} Fase 0: ${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);

// Juiz LLM para o teste A/B. Avalia QUALIDADE de pergunta/follow-up, cego e
// com ordem A/B randomizada (anti-viés de posição). Roda no modelo forte.
//
// Dois modos:
//  - judgeCounterfactual: por turno, mesmo contexto, duas próximas ações
//    candidatas (modelo forte vs rápido) -> qual é melhor.
//  - judgeHolistic: duas entrevistas completas (uma de cada braço, mesma
//    persona) -> qual conduziu a melhor entrevista no geral.

const RUBRIC = `Criterios de QUALIDADE (foco em perguntas e follow-ups de uma entrevista de arguicao conduzida por uma persona "dona de restaurante / cliente decisor"):
1. Relevancia e profundidade: a pergunta ataca um ponto que importa (premissa, risco, contradicao, decisao) em vez de algo raso ou generico.
2. Sondagem de lacuna real vs encheção: follow-up so quando ha incoerencia/contradicao/incompletude real; nao insistir a toa nem repetir.
3. Captura de contradicoes: percebe e cobra divergencias internas da entrega (ex.: taxa 10% vs 14%; recomenda Opcao A mas a tabela favorece a Opcao B; promete 3 cenarios e entrega 2) e lacunas pedidas pelo cliente (ex.: troca do inversor).
4. Fidelidade a persona: fala como cliente decisor (intuicao, consequencia pratica, sensibilidade, justificativa de decisao), NAO como avaliador academico ("reconstrua", "mostre passo a passo").
5. Respeita o principio da resposta formulavel de cabeca: NAO exige recalculo ao vivo de VPL/TIR/sensibilidade; aceita direcao + mecanismo + ordem de grandeza.
6. Naturalidade e foco: clara, conversacional, um foco por vez.`;

function extractJson(text) {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("juiz: sem JSON na resposta");
    return JSON.parse(m[0]);
}

function fmtAction(a) {
    if (!a) return "(nenhuma)";
    const extra = [
        a.follow_up_reason ? `follow_up_reason=${a.follow_up_reason}` : null,
        a.finalize_reason ? `finalize_reason=${a.finalize_reason}` : null,
        a.hint ? `hint=${JSON.stringify(a.hint)}` : null,
    ].filter(Boolean).join(" ");
    return `kind=${a.kind}${extra ? " " + extra : ""}\nfala: "${a.message}"`;
}

function fmtTail(tail) {
    return tail.map((h) => `${h.role === "interviewer" ? "Entrevistadora" : "Aluno"}: ${h.text}`).join("\n");
}

function withReasoningEffort(payload, effort) {
    return effort ? { ...payload, reasoning: { effort } } : payload;
}

// Julga uma amostra counterfactual. Retorna { winner: "strong"|"fast"|"tie", dims, reason }.
export async function judgeCounterfactualSample(client, judgeModel, sample, judgeEffort = null) {
    // Randomiza posição.
    const flip = Math.random() < 0.5;
    const A = flip ? sample.counterfactualAction : sample.driverAction; // se flip, A=fast
    const B = flip ? sample.driverAction : sample.counterfactualAction;
    // No counterfactual: driverAction = modelo FORTE (conduz), counterfactualAction = RÁPIDO.
    const aIsFast = flip;

    const instructions = `Voce e um avaliador rigoroso e imparcial de entrevistas de arguicao. Recebe o contexto de UM turno e DUAS proximas acoes candidatas (A e B) propostas por dois entrevistadores diferentes para o MESMO contexto. Decida qual acao e MELHOR pela rubrica. Seja exigente; so use "tie" se forem genuinamente equivalentes. Responda APENAS com JSON.\n\n${RUBRIC}`;
    const input = `CONTEXTO (ultimas falas, terminando na fala do aluno que as candidatas respondem):
${fmtTail(sample.contextTail)}

CANDIDATA A:
${fmtAction(A)}

CANDIDATA B:
${fmtAction(B)}

Retorne JSON:
{
  "winner": "A" | "B" | "tie",
  "dimensions": { "relevancia": "A|B|tie", "follow_up_apropriado": "A|B|tie", "captura_contradicoes": "A|B|tie", "fidelidade_persona": "A|B|tie", "resposta_de_cabeca": "A|B|tie" },
  "reason": "1-2 frases justificando o vencedor"
}`;

    const res = await client.responses.create(withReasoningEffort({ model: judgeModel, instructions, input }, judgeEffort));
    const parsed = extractJson(res.output_text || "");
    const mapWinner = (w) => (w === "tie" ? "tie" : (w === "A" ? (aIsFast ? "fast" : "strong") : (aIsFast ? "strong" : "fast")));
    const winner = mapWinner(parsed.winner);
    const dims = {};
    for (const [k, v] of Object.entries(parsed.dimensions || {})) dims[k] = mapWinner(v);
    return { winner, dims, reason: parsed.reason || "", turnIndex: sample.turnIndex, persona: sample.persona };
}

function fmtTranscript(transcript) {
    return transcript
        .map((h) => {
            if (h.role === "student") return `Aluno: ${h.text}`;
            const tag = h.kind ? `[${h.kind}${h.follow_up_reason ? ":" + h.follow_up_reason : ""}] ` : "";
            return `Entrevistadora ${tag}: ${h.text}`;
        })
        .join("\n");
}

// Julga duas entrevistas completas (mesma persona). Retorna
// { winner: "strong"|"fast"|"tie", scores: {strong:{...}, fast:{...}}, reason }.
export async function judgeHolisticPair(client, judgeModel, strongRun, fastRun, judgeEffort = null) {
    const flip = Math.random() < 0.5;
    const A = flip ? fastRun : strongRun;
    const B = flip ? strongRun : fastRun;
    const aIsFast = flip;

    const instructions = `Voce e um avaliador rigoroso e imparcial. Recebe DUAS transcricoes (A e B) de entrevistas de arguicao sobre O MESMO trabalho, com O MESMO aluno simulado, conduzidas por dois entrevistadores diferentes. Avalie a QUALIDADE GERAL da conducao (perguntas e follow-ups) pela rubrica. De notas 1-5 por dimensao para cada uma e escolha a melhor no geral. Responda APENAS com JSON.\n\n${RUBRIC}`;
    const input = `TRANSCRICAO A:
${fmtTranscript(A.transcript)}

=====================

TRANSCRICAO B:
${fmtTranscript(B.transcript)}

Retorne JSON:
{
  "scores": {
    "A": { "relevancia": 1-5, "follow_up_apropriado": 1-5, "captura_contradicoes": 1-5, "fidelidade_persona": 1-5, "resposta_de_cabeca": 1-5 },
    "B": { "relevancia": 1-5, "follow_up_apropriado": 1-5, "captura_contradicoes": 1-5, "fidelidade_persona": 1-5, "resposta_de_cabeca": 1-5 }
  },
  "winner": "A" | "B" | "tie",
  "reason": "2-3 frases comparando"
}`;

    const res = await client.responses.create(withReasoningEffort({ model: judgeModel, instructions, input }, judgeEffort));
    const parsed = extractJson(res.output_text || "");
    const mapWinner = (w) => (w === "tie" ? "tie" : (w === "A" ? (aIsFast ? "fast" : "strong") : (aIsFast ? "strong" : "fast")));
    const scores = {
        strong: aIsFast ? parsed.scores?.B : parsed.scores?.A,
        fast: aIsFast ? parsed.scores?.A : parsed.scores?.B,
    };
    return { winner: mapWinner(parsed.winner), scores, reason: parsed.reason || "", persona: strongRun.persona };
}

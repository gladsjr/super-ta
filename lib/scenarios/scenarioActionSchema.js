// Contrato de saída do ScenarioOrchestratorAgent (sistema multiagente).
//
// Dois formatos, um por modo de turno:
//   - TURNO "student" (aluno↔persona(s)): o orquestrador escolhe QUAL persona
//     responde e o QUE ela diz, ou sinaliza que a interação chegou ao fim.
//   - "persona_exchange" (duas personas conversam): o orquestrador devolve uma
//     sequência curta de falas entre as personas sobre o foco.
//
// Análogo a lib/superOrchestrator/actionSchema.js, porém mais enxuto: aqui o
// "kind" do turno cobre só falar / avançar / encerrar a interação — a navegação
// entre interações é do código (liveEngine + rotas), não do LLM.

export const TURN_KINDS = ["speak", "advance", "finalize"];

export const SCENARIO_TURN_SCHEMA_DESCRIPTION = `
{
  "speaker_persona_id": "id da persona que responde (DEVE ser um dos participantes listados). Em advance/finalize, repita o id de quem encerra a fala.",
  "action": {
    "kind": "speak | advance | finalize",
    // speak: a persona reage/pergunta. message OBRIGATÓRIA.
    // advance: o objetivo desta interação foi suficientemente coberto — passar à próxima etapa. message pode ser uma fala curta de transição ou "".
    // finalize: a outra ponta quer encerrar / desengajou. message curto de fechamento.
    "message": "fala em voz da persona; vai para a outra ponta SEM edição (em speak é obrigatória)"
  },
  "rationale": "OBRIGATÓRIO, não-vazio. Justifica a escolha do falante e da ação. Vai para o log do professor — auditoria, não chain-of-thought.",
  "memory": {
    "open_threads": ["pontos relevantes ainda não cobertos nesta interação"],
    "free_notes": "observações que ajudam nos próximos turnos"
  }
}

ORDEM DE EMISSÃO: emita "action" primeiro (com "message" no início), depois "rationale", depois "memory". NÃO reordene.
`;

export const PERSONA_EXCHANGE_SCHEMA_DESCRIPTION = `
{
  "lines": [
    { "speaker_persona_id": "id de uma das DUAS personas", "message": "fala curta em voz dela" }
    // 2 a 4 falas, alternando entre as duas personas, conversando sobre o foco.
    // A outra ponta apenas observa esta troca — não há fala dela aqui.
  ],
  "rationale": "OBRIGATÓRIO, não-vazio. Por que a troca soou assim."
}
`;

const isNonEmptyStr = x => typeof x === "string" && x.trim().length > 0;

// Valida um turno "student". allowedIds = ids das personas participantes.
export function validateScenarioTurn(parsed, allowedIds = []) {
    const errors = [];
    const allow = new Set(allowedIds);
    if (!parsed || typeof parsed !== "object") return { valid: false, errors: ["payload não é objeto"] };
    if (!isNonEmptyStr(parsed.rationale)) errors.push("rationale é obrigatório (string não-vazia)");
    const a = parsed.action;
    if (!a || typeof a !== "object") {
        errors.push("action é obrigatório (objeto)");
        return { valid: false, errors };
    }
    if (!TURN_KINDS.includes(a.kind)) errors.push(`action.kind inválido: ${JSON.stringify(a.kind)}`);
    if (a.kind === "speak" && !isNonEmptyStr(a.message)) errors.push("action.message é obrigatório em speak");
    if (!isNonEmptyStr(parsed.speaker_persona_id)) {
        errors.push("speaker_persona_id é obrigatório");
    } else if (a.kind === "speak" && allow.size && !allow.has(parsed.speaker_persona_id)) {
        errors.push(`speaker_persona_id fora dos participantes: ${parsed.speaker_persona_id}`);
    }
    if (parsed.memory !== undefined && (typeof parsed.memory !== "object" || parsed.memory === null)) {
        errors.push("memory, se presente, deve ser objeto");
    }
    return { valid: errors.length === 0, errors };
}

// Valida a troca persona↔persona. allowedIds = ids das 2 personas.
export function validatePersonaExchange(parsed, allowedIds = []) {
    const errors = [];
    const allow = new Set(allowedIds);
    if (!parsed || typeof parsed !== "object") return { valid: false, errors: ["payload não é objeto"] };
    if (!isNonEmptyStr(parsed.rationale)) errors.push("rationale é obrigatório (string não-vazia)");
    if (!Array.isArray(parsed.lines) || parsed.lines.length < 1) {
        errors.push("lines deve ser uma lista não-vazia");
        return { valid: errors.length === 0, errors };
    }
    if (parsed.lines.length > 6) errors.push("lines: máximo de 6 falas");
    parsed.lines.forEach((l, i) => {
        if (!l || typeof l !== "object") { errors.push(`lines[${i}] não é objeto`); return; }
        if (!isNonEmptyStr(l.message)) errors.push(`lines[${i}].message vazia`);
        if (!isNonEmptyStr(l.speaker_persona_id)) errors.push(`lines[${i}].speaker_persona_id vazio`);
        else if (allow.size && !allow.has(l.speaker_persona_id)) errors.push(`lines[${i}].speaker_persona_id fora das personas: ${l.speaker_persona_id}`);
    });
    return { valid: errors.length === 0, errors };
}

// Extrai o primeiro objeto JSON de um texto (tolerante a cercas/prosa em volta).
export function extractJsonObject(text) {
    const m = typeof text === "string" ? text.match(/\{[\s\S]*\}/) : null;
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
}

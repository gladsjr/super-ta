// Contrato de saída do SuperOrchestratorAgent.
//
// Esta é a peça mais crítica do experimento. Toda decisão do agente vira uma
// "action" deste schema, e o despachante (routes/interview.js, a partir da
// fase 3) reage ao `kind`. Mudar este arquivo é mudar o protocolo entre o
// LLM e o código — fazer com intenção.
//
// Ver docs/super-orchestrator-plan.md para o desenho completo.

export const ACTION_KINDS = [
    "ask",          // próxima pergunta (do plano ou espontânea — ex.: retomar tópico)
    "follow_up",    // pedido de complemento sobre um turno específico
    "meta_modal",   // intervenção que vai para modal (meta-pergunta do aluno)
    "hint",         // balão de Dica fora do roleplay
    "finalize",     // encerra a entrevista
    "ask_repeat",   // pede repetição (também usado como fallback se schema vier inválido)
];

export const FOLLOW_UP_REASONS = [
    "incoherence",
    "incomplete",
    "diminishing_returns",
    // Verificação ativa por turno (ver bloco "VERIFICAÇÃO DE CONTRADIÇÕES" no
    // SuperOrchestrator.systemPromptBody).
    "contradicts_work",         // a fala contradiz algo da entrega (file_search confirmou)
    "contradicts_earlier_self", // a fala contradiz algo dito pela própria outra ponta antes nesta entrevista
    // Pedido de pulo (ver bloco "PEDIDO DE PULO" no SuperOrchestrator).
    "confirm_skip",             // sinal ambíguo de querer pular — agente confirma antes de agir
];

export const FINALIZE_REASONS = [
    "plan_exhausted",
    "diminishing_returns_overall",
    "student_disengaged",
];

// Descrição textual usada nos prompts do agente para instruir o formato de
// saída. Mantenha em sincronia com validateAction() abaixo.
export const ACTION_SCHEMA_DESCRIPTION = `
{
  "action": {
    "kind": "ask | follow_up | meta_modal | hint | finalize | ask_repeat",
    "message": "OBRIGATÓRIO. Fala em voz da persona, vai para o aluno via TTS.",

    // Só em "ask":
    "plan_question_id": <id da pergunta do plano OU null se espontânea>,
    "revisit_topic": "<string OU null; se a ask retoma um tópico anterior>",
    "objectives":         ["itens exatos do agent.objectives do YAML, ou []"],
    "concerns":           ["itens exatos do agent.concerns, ou []"],
    "decision_criteria":  ["itens exatos do agent.decision_criteria, ou []"],
    "information_needs":  ["itens exatos do agent.information_needs, ou []"],
    "evaluation_mode":    ["itens exatos do agent.evaluation_mode, ou []"],

    // Só em "follow_up":
    "about_turn_index": <índice do turno referenciado>,
    "follow_up_reason": "incoherence | incomplete | diminishing_returns | contradicts_work | contradicts_earlier_self | confirm_skip",

    // Só em "hint":
    "hint": { "title": "string curta", "body": "string com a orientação" },

    // Só em "finalize":
    "finalize_reason": "plan_exhausted | diminishing_returns_overall | student_disengaged"
  },
  "rationale": "OBRIGATÓRIO, string não-vazia. Justifica a ação. Vai para o log do professor — escreva como auditoria, não como chain-of-thought.",
  "memory": {
    "questions_covered": [<ids do plano já respondidos satisfatoriamente>],
    "questions_skipped": [<ids do plano descartados — substituem QuestionRelevance>],
    "open_threads":      ["string", "..."],
    "free_notes":        "string"
  }
}

ORDEM DE EMISSÃO (OBRIGATÓRIA): emita "action" PRIMEIRO (com "message" logo no início dela), depois "rationale", depois "memory". A fala em action.message é convertida em áudio assim que a string fecha no stream — emiti-la primeiro reduz a latência percebida pela outra ponta. NÃO reordene os campos.
`;

// Validação estrutural. Retorna { valid, errors }.
// Não valida semântica — só shape. Schema inválido cai para fallback ask_repeat
// no despachante (a ser feito na fase 3 em routes/interview.js).
export function validateAction(parsed) {
    const errors = [];
    if (!parsed || typeof parsed !== "object") {
        return { valid: false, errors: ["payload não é objeto"] };
    }
    if (typeof parsed.rationale !== "string" || !parsed.rationale.trim()) {
        errors.push("rationale é obrigatório (string não-vazia)");
    }
    const action = parsed.action;
    if (!action || typeof action !== "object") {
        errors.push("action é obrigatório (objeto)");
        return { valid: false, errors };
    }
    if (!ACTION_KINDS.includes(action.kind)) {
        errors.push(`action.kind inválido: ${JSON.stringify(action.kind)}`);
    }
    if (typeof action.message !== "string" || !action.message.trim()) {
        errors.push("action.message é obrigatório (string não-vazia)");
    }
    if (action.kind === "follow_up") {
        if (action.follow_up_reason !== undefined && !FOLLOW_UP_REASONS.includes(action.follow_up_reason)) {
            errors.push(`follow_up_reason inválido: ${JSON.stringify(action.follow_up_reason)}`);
        }
    }
    if (action.kind === "finalize") {
        if (action.finalize_reason !== undefined && !FINALIZE_REASONS.includes(action.finalize_reason)) {
            errors.push(`finalize_reason inválido: ${JSON.stringify(action.finalize_reason)}`);
        }
    }
    if (action.kind === "hint") {
        const h = action.hint;
        if (!h || typeof h.title !== "string" || typeof h.body !== "string") {
            errors.push("hint exige { title: string, body: string }");
        }
    }
    // memory é opcional (agente pode omitir; código mantém a anterior).
    if (parsed.memory !== undefined && (typeof parsed.memory !== "object" || parsed.memory === null)) {
        errors.push("memory, se presente, deve ser objeto");
    }
    return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Streaming-parse: extrai o valor de uma chave-string de um JSON POSSIVELMENTE
// TRUNCADO (o stream do super-orquestrador, antes de fechar). Robusto a escapes
// (\" \\ \n \uXXXX). Retorna { value, complete } — complete=true quando a aspa
// de fechamento não-escapada foi vista — ou null se a chave/abertura ainda não
// apareceu no texto parcial. Pega a PRIMEIRA ocorrência da chave.
// ---------------------------------------------------------------------------
export function extractJsonStringValue(text, key) {
    const marker = `"${key}"`;
    let i = text.indexOf(marker);
    if (i < 0) return null;
    i += marker.length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== ":") return null;
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return null;
    if (text[i] !== '"') return null; // valor não-string, ou ainda não chegou
    i++;
    let out = "";
    while (i < text.length) {
        const c = text[i];
        if (c === "\\") {
            const next = text[i + 1];
            if (next === undefined) return { value: out, complete: false }; // truncou no escape
            if (next === "u") {
                const hex = text.slice(i + 2, i + 6);
                if (hex.length < 4) return { value: out, complete: false };
                const code = parseInt(hex, 16);
                out += Number.isNaN(code) ? "" : String.fromCharCode(code);
                i += 6;
            } else {
                const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f" };
                out += map[next] ?? next;
                i += 2;
            }
        } else if (c === '"') {
            return { value: out, complete: true };
        } else {
            out += c;
            i++;
        }
    }
    return { value: out, complete: false }; // string ainda aberta
}

// Gatilho otimista do streaming-parse: tenta extrair action.kind + action.message
// de um JSON (possivelmente parcial). Retorna { kind, message } SÓ quando ambos
// estão prontos (kind ∈ ACTION_KINDS e a string da message fechou). Com a ordem
// de emissão action→rationale→memory, ambos aparecem cedo. Não substitui
// validateAction — é só o sinal para disparar o TTS sem esperar o JSON inteiro.
export function extractReadyAction(text) {
    const kind = extractJsonStringValue(text, "kind");
    if (!kind || !kind.complete || !ACTION_KINDS.includes(kind.value)) return null;
    const message = extractJsonStringValue(text, "message");
    if (!message || !message.complete || !message.value.trim()) return null;
    return { kind: kind.value, message: message.value };
}

import log from "../lib/logger.js";
import { runStructured } from "../lib/agentRun.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * OralCalibrationAgent
 *
 * Gera a FRASE DE CALIBRAÇÃO DE FALA da prova oral: uma frase curta e natural que o
 * aluno LÊ EM VOZ ALTA no pré-teste de captação (antes de abrir a sessão de voz),
 * contendo 2–4 TERMOS DO DOMÍNIO extraídos das perguntas/respostas da prova — os
 * termos difíceis de transcrever são justamente os que interessa testar. Também
 * devolve a lista desses termos (key_terms), que o sistema checa na transcrição da
 * repetição (lib/speechCalib.js).
 *
 * Roda na preparação da prova (a pedido do professor); a frase é editável por ele.
 *
 * Audience: professor_via_ui (a frase é lida/editada pelo professor e, depois, lida
 * em voz alta pelo aluno — não é fala de persona dentro da cena).
 *
 * Output JSON contract (espelhado em SCHEMA):
 *   { "sentence": "<a frase>", "key_terms": ["<termo1>", "<termo2>", ...] }
 */
export class OralCalibrationAgent {
    static TYPE = "oral_calibration";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for OralCalibrationAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Sua função específica: escrever UMA frase curta de CALIBRAÇÃO DE FALA para o início de uma prova oral. O aluno vai LER essa frase EM VOZ ALTA e o sistema vai transcrevê-la para verificar se a captação da fala dele está boa. Portanto a frase precisa: (a) ser natural e fácil de ler em voz alta; (b) conter de 2 a 4 TERMOS DO DOMÍNIO da prova (jargão, siglas, nomes técnicos) tirados das perguntas/respostas — são os termos difíceis de transcrever que interessa testar.

FORMATO: uma única frase afirmativa, ~12 a 25 palavras, no espírito de "As questões desta prova falam de X, Y e Z." (varie a redação à vontade, mantendo natural). Nada de perguntas, listas, aspas ou markdown.

key_terms: a lista (2 a 4) dos termos do domínio que você embutiu na frase, EXATAMENTE como aparecem nela (o sistema checa se sobreviveram à transcrição). Prefira termos DISTINTIVOS (jargão, siglas, nomes próprios técnicos), não palavras comuns.

REGRAS:
- Baseie os termos SOMENTE nas perguntas/respostas fornecidas; não invente jargão que não esteja lá.
- Português do Brasil; a frase será LIDA por uma pessoa — priorize pronunciabilidade.
- Se houver poucos termos técnicos, use os que houver (mínimo 2). Se não houver nenhum, escolha 2 substantivos centrais do tema.

# Saída
Apenas JSON válido, sem cercas markdown e sem texto antes/depois:
{ "sentence": "<a frase>", "key_terms": ["<termo1>", "<termo2>", ...] }`;
    }

    /**
     * @param {object} p
     * @param {Array<{question:string, answer?:string}>} p.items - perguntas (e respostas, se houver) da prova
     * @param {object|null} p.meterCtx
     * @returns {Promise<{sentence:string, key_terms:string[]}>}
     */
    async build({ items = [], meterCtx = null }) {
        const list = (Array.isArray(items) ? items : [])
            .map((it, i) => {
                const q = String(it?.question ?? "").trim();
                const a = String(it?.answer ?? "").trim();
                if (!q && !a) return null;
                return `${i + 1}. PERGUNTA: ${q || "(sem enunciado)"}${a ? `\n   RESPOSTA: ${a}` : ""}`;
            })
            .filter(Boolean)
            .join("\n");
        if (!list) throw new Error("OralCalibration: sem perguntas/respostas para extrair termos");

        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        const userText = `PERGUNTAS E RESPOSTAS DA PROVA:
${list}

Escreva a frase de calibração e liste os termos-chave embutidos.`;

        const { sentence, key_terms } = await runStructured({
            client: this.client, model: this.model, label: "AGENT:OralCalibration",
            instructions: systemPrompt, input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
            schema: SCHEMA, schemaName: "oral_calibration", meterCtx,
            promptLog: systemPrompt + "\n\n" + userText, maxAttempts: 2, extractObject: true,
            validate: (parsed) => {
                const s = typeof parsed.sentence === "string" ? parsed.sentence.trim() : "";
                if (!s) throw new Error("OralCalibration: sentence vazia");
                const terms = Array.isArray(parsed.key_terms)
                    ? [...new Set(parsed.key_terms.map(t => String(t ?? "").trim()).filter(Boolean))].slice(0, 4)
                    : [];
                return { sentence: s, key_terms: terms };
            },
        });
        log.info("AGENT:OralCalibration", `ok terms=${key_terms.length} len=${sentence.length}`);
        return { sentence, key_terms };
    }
}

// JSON Schema strict. Contagem/limpeza dos termos garantida no código (validate).
const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["sentence", "key_terms"],
    properties: {
        sentence: { type: "string" },
        key_terms: { type: "array", items: { type: "string" } },
    },
};

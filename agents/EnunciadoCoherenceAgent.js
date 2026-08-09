import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";

/**
 * EnunciadoCoherenceAgent
 *
 * CHECAGEM MÍNIMA do ENUNCIADO (PDF), automática no upload (issue #133, decisão
 * de 06/08/2026). NÃO avalia qualidade pedagógica/didática/dificuldade nem
 * "contexto de negócio" — só verifica UMA coisa: o enunciado deixa claro COM QUEM
 * o aluno vai conversar na arguição (a PERSONA/papel que o entrevistador assume)
 * e, se sim, quais as características dela.
 *
 * Antes era um avaliador qualitativo (overall/findings/personas/fixes) rodado por
 * botão. Trocado porque (a) induzia o professor a "consertar" o que não era
 * problema — ex.: exigir contexto de negócio num trabalho acadêmico; e (b) o botão
 * avaliava o enunciado ANTIGO por engano quando não havia arquivo novo. Sem botão
 * e rodando no upload, esses dois problemas somem por construção.
 *
 * Modelo: fast_model (checagem enxuta e barata, roda a cada upload).
 *
 * Output JSON contract:
 *   { "persona_defined": true|false,
 *     "persona": "<quem é o interlocutor, em poucas palavras>" | null,
 *     "characteristics": ["<traço curto>", ...] }
 */
export class EnunciadoCoherenceAgent {
    static TYPE = "enunciado_persona_check";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for EnunciadoCoherenceAgent");
        this.client = openaiClient;
        this.model = model;
        this.systemPromptBody = `Sua função: uma checagem MÍNIMA e objetiva do ENUNCIADO de um trabalho (PDF anexado), só para o processo de entrevista funcionar. Você NÃO avalia qualidade, didática, dificuldade, "contexto de negócio" nem correção do trabalho — NADA disso.

A ÚNICA coisa que você verifica: o enunciado deixa claro COM QUEM o aluno vai conversar na arguição — a PERSONA (o papel que o entrevistador vai assumir)? Pode ser um examinador acadêmico, um professor, um cliente, um investidor, um jornalista, um gestor — qualquer interlocutor. E, se define, quais são as CARACTERÍSTICAS dessa persona (postura, foco, o que ela quer do aluno)?

REGRAS:
- Se o enunciado define a persona (explícita OU claramente implícita no contexto): "persona_defined": true, preencha "persona" (quem é, em poucas palavras) e "characteristics" (2 a 5 traços curtos).
- Se NÃO dá para saber com quem o aluno vai conversar: "persona_defined": false, "persona": null, "characteristics": [].
- NÃO invente uma persona de negócio (cliente/decisor) quando o enunciado não sugere uma. Muitos trabalhos são acadêmicos — uma BANCA/EXAMINADOR é uma persona válida e suficiente. Só marque false quando realmente NÃO houver nenhum indício de interlocutor.
- Não comente qualidade nem faça sugestões de melhoria. Só a persona e as características.

# Saída
Apenas JSON válido, sem cercas markdown e sem texto antes/depois:
{ "persona_defined": true | false, "persona": "<string ou null>", "characteristics": ["<string>", ...] }`;
    }

    async evaluate({ openaiFileId, meterCtx = null }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        if (!openaiFileId) throw new Error("Missing openaiFileId for EnunciadoCoherenceAgent");

        const userText = `Analise o ENUNCIADO em anexo e produza o JSON conforme o contrato: ele define com QUEM o aluno vai conversar (a persona do entrevistador) e quais as características dela? Só isso.`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{
                role: "user",
                content: [
                    { type: "input_text", text: userText },
                    { type: "input_file", file_id: openaiFileId },
                ],
            }],
        };

        log.prompt("AGENT:EnunciadoPersonaCheck", systemPrompt + "\n\n" + userText);
        const response = await log.span("AGENT:EnunciadoPersonaCheck", "responses.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:EnunciadoPersonaCheck", model: this.model },
                () => (meterCtx?.openai ?? this.client).responses.create(payload)
            )
        );

        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:EnunciadoPersonaCheck", `no JSON: ${log.preview(text, 200)}`);
            throw new Error("EnunciadoCoherenceAgent: no JSON in response");
        }

        let parsed;
        try {
            parsed = JSON.parse(match[0]);
        } catch (err) {
            log.error("AGENT:EnunciadoPersonaCheck", `JSON parse failed: ${err.message}`);
            throw new Error("EnunciadoCoherenceAgent: invalid JSON in response");
        }

        return this._normalize(parsed);
    }

    // Normaliza e mantém a coerência: persona só "definida" se veio texto legível.
    _normalize(r) {
        const persona = typeof r?.persona === "string" && r.persona.trim() ? r.persona.trim() : null;
        const persona_defined = !!persona && r?.persona_defined !== false;
        const characteristics = persona_defined && Array.isArray(r?.characteristics)
            ? r.characteristics.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 6)
            : [];
        log.info("AGENT:EnunciadoPersonaCheck", `ok persona_defined=${persona_defined} chars=${characteristics.length}`);
        return { persona_defined, persona: persona_defined ? persona : null, characteristics };
    }
}

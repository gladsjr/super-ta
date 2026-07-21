// Chamada estruturada de agente: concentra o esqueleto repetido em ~todos os
// agentes (montar payload Responses + json_schema → log.prompt → log.span +
// meteredResponses + responses.create → extrair/parsear o JSON → validar → retry).
// Cada agente passa só o que VARIA: instructions, input, schema e um `validate`
// que mapeia/valida o JSON (lança p/ forçar retry). O `reasoning.effort` do modelo
// principal é injetado uniformemente por lib/openaiClient.js — não aqui.

import log from "./logger.js";
import { meteredResponses } from "./billing.js";

/**
 * @template R
 * @param {object} p
 * @param {object}  p.client                 cliente OpenAI
 * @param {string}  p.model
 * @param {string}  p.label                  rótulo p/ logs (ex.: "AGENT:Grading")
 * @param {string}  p.instructions           system prompt
 * @param {Array|string} p.input             input das Responses; string → vira mensagem de user
 * @param {object}  p.schema                 JSON Schema (strict)
 * @param {string}  p.schemaName             nome do schema (ex.: "criterion_grade")
 * @param {(parsed:any)=>R} [p.validate]     valida/mapeia o JSON; LANÇA p/ forçar retry. Default: devolve o parsed
 * @param {object|null} [p.meterCtx]
 * @param {number}  [p.maxAttempts=1]        nº de tentativas (>1 = retry em JSON inválido/validate que lança)
 * @param {boolean} [p.extractObject=false]  true: extrai o 1º {...} do texto (tolera prosa em volta); false: parseia o texto todo
 * @param {string}  [p.promptLog]            o que registrar em log.prompt (default: instructions)
 * @returns {Promise<R>}
 */
export async function runStructured({
    client, model, label, instructions, input, schema, schemaName,
    validate = (x) => x, meterCtx = null, maxAttempts = 1, extractObject = false, promptLog = null,
}) {
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
    const payload = {
        model,
        instructions,
        input: messages,
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
    };
    log.prompt(label, promptLog ?? instructions);

    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            // Cliente por-work: um work de benchmark injeta seu cliente dedicado
            // via meterCtx.openai (chave OPENAI_API_KEY_BENCHMARK). Ausente → cai
            // no `client` injetado no boot (produção). Ver lib/openaiClient.js.
            const cli = meterCtx?.openai ?? client;
            const response = await log.span(label, `responses.create${attempt > 1 ? ` retry#${attempt}` : ""}`, () =>
                meteredResponses({ ...(meterCtx || {}), agentLabel: label, model }, () => cli.responses.create(payload))
            );
            const text = response.output_text || "";
            let jsonText;
            if (extractObject) {
                const m = text.match(/\{[\s\S]*\}/);
                if (!m) throw new Error(`${label}: sem JSON na resposta (${log.preview(text, 120)})`);
                jsonText = m[0];
            } else {
                jsonText = text || "{}";
            }
            return validate(JSON.parse(jsonText));
        } catch (err) {
            lastErr = err;
            log.error(label, `tentativa ${attempt}/${maxAttempts} falhou: ${err.message}`);
        }
    }
    throw lastErr;
}

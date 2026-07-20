// Extração tolerante de um objeto JSON da saída de um modelo.
//
// Motivação: o SuperOrchestrator é o único agente sem json_schema (resposta em
// stream), e alguns modelos emitem texto residual DEPOIS do objeto JSON (medido
// com gpt-5.6-terra: ~1 resposta por entrevista, em qualquer effort; gpt-5.4:
// zero). O regex ganancioso /\{[\s\S]*\}/ engolia o sufixo até a última chave e
// o JSON.parse caía em "Unexpected non-whitespace character after JSON" — que o
// despachante convertia em ask_repeat ("pode repetir?"); quando o mesmo turno
// re-falhava, virava loop de repetições. Esta função devolve o PRIMEIRO objeto
// balanceado (ciente de strings e escapes) e expõe o que sobrou em volta para o
// caller logar. Não valida o conteúdo — isso segue com JSON.parse + schema.

/**
 * Localiza o primeiro objeto JSON balanceado em `text`.
 *
 * @param {string} text - saída crua do modelo
 * @returns {{ json: string, leading: string, trailing: string } | null}
 *   `json` = fatia balanceada do primeiro "{" ao seu "}" correspondente;
 *   `leading`/`trailing` = texto residual (aparado) antes/depois da fatia.
 *   `null` = não há "{" ou o objeto não fecha (saída truncada).
 */
export function extractFirstJsonObject(text) {
    if (typeof text !== "string") return null;
    const start = text.indexOf("{");
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === "{") {
            depth++;
        } else if (ch === "}") {
            depth--;
            if (depth === 0) {
                return {
                    json: text.slice(start, i + 1),
                    leading: text.slice(0, start).trim(),
                    trailing: text.slice(i + 1).trim(),
                };
            }
        }
    }
    return null;
}

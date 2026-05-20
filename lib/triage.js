// Lógica de desempate da triagem (scope / off-topic / meta).
// O threshold em si vem de policy.yaml via lib/config.js.

import { TRIAGE_THRESHOLD } from "./config.js";

// Ordem de desempate quando dois agentes de triagem retornam a mesma
// intensidade máxima. Rationale: meta é o indicador mais distintivo (mau
// funcionamento do sistema vs confusão on-topic); scope clarification deve
// preceder off-topic redirect para não empurrar um aluno confuso "de volta"
// antes de esclarecer.
export const TRIAGE_PRIORITY = ["meta", "scope_clarification", "off_topic_redirect"];

export function pickTriageWinner(results) {
    let best = null;
    for (const r of results) {
        if (r.intensity < TRIAGE_THRESHOLD) continue;
        if (!best) { best = r; continue; }
        if (r.intensity > best.intensity) { best = r; continue; }
        if (r.intensity === best.intensity &&
            TRIAGE_PRIORITY.indexOf(r.type) < TRIAGE_PRIORITY.indexOf(best.type)) {
            best = r;
        }
    }
    return best;
}

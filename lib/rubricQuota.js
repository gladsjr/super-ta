// Cota de GERAÇÃO DE RUBRICAS da prova oral (issue #192). A conferência é feita
// ANTES de qualquer chamada ao modelo — gerar até acabar e parar no meio deixaria
// a prova inconsistente (parte com rubrica, parte sem), que é o que dispara o 409
// na avaliação.
//
// O CONTADOR conta QUESTÕES COM RUBRICA (nunca chamadas ao modelo): só as rubricas
// NOVAS (questão que não tinha rubrica) debitam a cota; regerar uma rubrica que já
// existe não debita. Senão, agrupar a geração por bloco (issue irmã, #194) viraria
// forma de burlar a cota.
//
// A FONTE do saldo ainda não está decidida (por trabalho / por professor / por
// alocação de pacote — entitlement_counters). Enquanto isso: teto CONFIGURÁVEL
// (RUBRIC_QUOTA_LIMIT) e um ÚNICO ponto de leitura (rubricQuota), para trocar a
// fonte depois sem mexer no resto. Sem teto configurado = ILIMITADO (dev/piloto
// seguem como antes; a UI ainda mostra quantas serão geradas).

import { questionHasRubric } from "./oralRubric.js";

const RAW = process.env.RUBRIC_QUOTA_LIMIT;
export const RUBRIC_QUOTA_LIMIT =
    RAW != null && RAW !== "" && Number.isFinite(Number(RAW)) && Number(RAW) >= 0 ? Number(RAW) : null;

// Saldo da cota de rubricas para um trabalho. `questions` = banco atual do
// trabalho (db.getOralQuestions). PONTO ÚNICO: quando o escopo (professor/
// alocação) for decidido, troque a fonte de `used`/`limit` só aqui.
export function rubricQuota(questions) {
    const used = (questions || []).filter(q => questionHasRubric(q)).length;
    const limit = RUBRIC_QUOTA_LIMIT;
    const remaining = limit == null ? Infinity : Math.max(0, limit - used);
    return { limit, used, remaining };
}

// Quantas rubricas NOVAS (que debitam cota) há entre os alvos de geração.
export function rubricsThatConsume(targets) {
    return (targets || []).filter(q => !questionHasRubric(q)).length;
}

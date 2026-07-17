// Teste one-shot: gera o plano de entrevista REAL (analyzeWork + buildPlan)
// com a persona Jornalista atual sobre dois PDFs reais anexados pelo professor.
// Reusa buildSharedPrep do harness A/B (mesmo caminho da produção, sem servidor).
//
// Uso: node -r dotenv/config tests/prep-journalist-live.mjs
// Saída: /tmp/prep_journalist_result.json + perguntas no stdout.

import "dotenv/config";
import fs from "node:fs";

import { loadPricing } from "../lib/billing.js";
import { PRINCIPAL_REASONING_MODEL } from "../lib/config.js";
import { openai } from "../lib/openaiClient.js";
import { buildSharedPrep } from "./ab-orchestrator/prep.mjs";

loadPricing();

const ENUNCIADO = "attached_assets/Trabalho_Final_MBA_FGV_1784322494195.pdf";
const TRABALHO = "attached_assets/Blockchain_Trabalho_Final_Gabriel_Eugenio_de_Melo_1784322660055.pdf";
const PERSONA = "config/interviewers/Journalist.yaml";
const QUESTION_COUNT = 6; // igual ao trabalho real em produção

const enunciadoBuf = fs.readFileSync(ENUNCIADO);
const trabalhoBuf = fs.readFileSync(TRABALHO);
const interviewerYaml = fs.readFileSync(PERSONA, "utf8");

console.log(`[teste] modelo=${PRINCIPAL_REASONING_MODEL} perguntas=${QUESTION_COUNT}`);
const t0 = Date.now();

const prep = await buildSharedPrep({
    prepClient: openai,
    prepModel: PRINCIPAL_REASONING_MODEL,
    enunciadoBuf,
    trabalhoBuf,
    interviewerYaml,
    questionCount: QUESTION_COUNT,
});

fs.writeFileSync(
    "/tmp/prep_journalist_result.json",
    JSON.stringify({ analysis: prep.analysis, plan: prep.plan }, null, 2),
);

console.log(`\n[teste] concluído em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log("\n================= PERGUNTAS DO PLANO =================\n");
prep.plan.questions.forEach((q, i) => {
    console.log(`--- Pergunta ${i + 1} ---`);
    console.log(JSON.stringify(q, null, 2));
    console.log("");
});
console.log("PREP_TEST_DONE");

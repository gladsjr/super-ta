// Preparação compartilhada do teste A/B: replica o que lib/sessionLifecycle.js
// faz no /upload, mas fora do servidor HTTP e sem Postgres.
//
// CHAVE METODOLÓGICA: a prep (analyzeWork + buildPlan) roda UMA vez, no modelo
// FORTE, e o resultado (work_analysis + plano) é COMPARTILHADO pelos dois
// braços. Assim a única variável entre braços é o modelo do super-orquestrador
// — o plano e a análise são idênticos.

import OpenAI from "openai";
import { openai } from "../../lib/openaiClient.js";
import { PrepBuilderAgent } from "../../agents/PrepBuilderAgent.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadPdf(buf, filename) {
    const file = await openai.files.create({
        file: await OpenAI.toFile(buf, filename),
        purpose: "user_data",
    });
    return file.id;
}

// Cria o vector store com os DOIS PDFs e espera ficar "completed" (produção não
// espera porque conta com a janela do intro; aqui esperamos para o file_search
// já estar quente no primeiro turno).
async function createVectorStore(fileIds, tag) {
    const vs = await openai.vectorStores.create({
        name: `abtest_${tag}_${Date.now()}`,
        file_ids: fileIds,
    });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        const cur = await openai.vectorStores.retrieve(vs.id);
        if (cur.status === "completed") return vs.id;
        if (cur.status === "failed" || cur.status === "cancelled") {
            throw new Error(`vector store ${cur.status}`);
        }
        await sleep(1500);
    }
    console.warn("[prep] vector store ainda não 'completed' após 90s; seguindo mesmo assim");
    return vs.id;
}

// Roda uma vez. Retorna { studentFileId, enunciadoFileId, vectorStoreId, analysis, plan }.
// `prepClient` é o cliente instrumentado para contabilizar o custo da prep.
export async function buildSharedPrep({
    prepClient,
    prepModel,
    enunciadoBuf,
    trabalhoBuf,
    interviewerYaml,
    questionCount,
}) {
    console.log("[prep] subindo PDFs sintéticos...");
    const [studentFileId, enunciadoFileId] = await Promise.all([
        uploadPdf(trabalhoBuf, "trabalho.pdf"),
        uploadPdf(enunciadoBuf, "enunciado.pdf"),
    ]);
    console.log(`[prep] files: aluno=${studentFileId} enunciado=${enunciadoFileId}`);

    console.log("[prep] criando vector store (com os 2 PDFs)...");
    const vectorStoreId = await createVectorStore([studentFileId, enunciadoFileId], "shared");
    console.log(`[prep] vector store=${vectorStoreId}`);

    const prep = new PrepBuilderAgent(prepClient, prepModel);
    const meterCtx = { workId: null };

    console.log(`[prep] analyzeWork (modelo=${prepModel})...`);
    const analysis = await prep.analyzeWork({ studentFileId, enunciadoFileId, interviewerYamlText: interviewerYaml, meterCtx });
    console.log(`[prep] análise ok — contradições detectadas=${analysis?.assessment?.internal_contradictions?.length ?? 0}`);

    console.log(`[prep] buildPlan (${questionCount} perguntas)...`);
    const plan = await prep.buildPlan({ analysis, studentFileId, enunciadoFileId, interviewerYamlText: interviewerYaml, questionCount, meterCtx });
    console.log(`[prep] plano ok — perguntas=${plan.questions.length}`);

    return { studentFileId, enunciadoFileId, vectorStoreId, analysis, plan };
}

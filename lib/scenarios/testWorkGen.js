// Geração de um TRABALHO DO ALUNO plausível para o MODO DE TESTE do professor.
// Pega o contexto (enunciado + cenário + etapa), gera o texto via LLM e devolve
// um PDF (pdfkit). É uma conveniência de teste — NUNCA usada no fluxo do aluno
// real (o endpoint que a chama exige submissão is_test).
import PDFDocument from "pdfkit";
import { openai } from "../openaiClient.js";
import { FAST_MODEL } from "../config.js";
import { meteredResponses } from "../billing.js";

const SYS = `Você gera um TRABALHO DO ALUNO plausível, em português do Brasil, para TESTAR um cenário de role-play (o aluno depois apresenta/defende este trabalho a uma persona). Produza um documento curto e COERENTE com o enunciado/caso e com a etapa indicada: estrutura em seções, com alguns NÚMEROS e PREMISSAS concretos (para a persona ter o que questionar) e uma recomendação final. Não precisa ser perfeito — pode ter 1 ou 2 fragilidades plausíveis (ajuda a exercitar a arguição). Texto corrido, com títulos de seção em linhas próprias; SEM markdown (nada de #, *, tabelas). 1 a 2 páginas.`;

export async function generateWorkText({ scenario, interaction, enunciadoFileId = null, meterCtx = null }) {
    const ctx = `CENÁRIO: ${scenario?.name || "(sem nome)"}\n${scenario?.description || ""}\n\nETAPA EM QUE O ALUNO APRESENTA O TRABALHO: ${interaction?.title || ""}\nTAREFA DO ALUNO NESTA ETAPA: ${interaction?.instruction || ""}\n\nGere o trabalho do aluno para esta etapa, ancorado no enunciado/caso quando houver.`;
    const content = [{ type: "input_text", text: ctx }];
    if (enunciadoFileId) content.push({ type: "input_file", file_id: enunciadoFileId });
    const r = await meteredResponses({ ...(meterCtx || {}), agentLabel: "AGENT:TestWorkGen", model: FAST_MODEL }, () =>
        openai.responses.create({ model: FAST_MODEL, instructions: SYS, input: [{ role: "user", content }] }));
    return (r.output_text || "").trim();
}

export function textToPdfBuffer(title, text) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 54, info: { Title: title || "Trabalho do aluno (teste)" } });
            const chunks = [];
            doc.on("data", c => chunks.push(c));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);
            doc.fontSize(15).text(title || "Trabalho do aluno (teste)");
            doc.moveDown(0.7);
            doc.fontSize(11).text(text || "", { align: "left", lineGap: 2 });
            doc.end();
        } catch (e) { reject(e); }
    });
}

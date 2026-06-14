import OpenAI from "openai";
import { openai } from "./openaiClient.js";

// Sobe um PDF para a Files API como `user_data` e devolve o objeto do upload
// (use `.id`). Centraliza o idioma `files.create({ file: toFile(...) })` que
// estava repetido nas rotas do professor (avaliação, adapt, coerência).
//
// blob: { pdf: Buffer|Blob, filename?: string }  — shape de db.getEnunciadoBlob
//       / db.getStudentPdfBlob.
// fallbackName: nome usado quando o blob não tem filename.
export async function uploadPdf(blob, fallbackName) {
    return openai.files.create({
        file: await OpenAI.toFile(blob.pdf, blob.filename || fallbackName),
        purpose: "user_data",
    });
}

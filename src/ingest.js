import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse";
import { createCanvas } from "canvas";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
  const workerPath = path.join(
    __dirname,
    "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"
  );
  if (fs.existsSync(workerPath)) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerPath;
  }
} catch (err) {
  console.warn("[ingest] Não foi possível configurar worker do pdfjs-dist", err);
}

const DEFAULT_TEXT_THRESHOLD = 500;
const DEFAULT_MAX_PAGES = 30;
const DEFAULT_OCR_CONCURRENCY = 4;
const DEFAULT_SCALE = 2;

const OCR_PROMPT = `Você é um extrator. Transcreva todo o texto legível desta página.\nSe houver tabela, retorne também uma versão TSV simples.\nSe houver gráfico/figura, descreva título, eixos e tendência.\nSeja fiel, preserve a ordem de leitura e insira cabeçalho "Página X".`;

function normalizeParsedText(rawText, limitPages) {
  if (!rawText) return "";
  const pages = rawText.split(/\f/g);
  const cap = typeof limitPages === "number" && limitPages > 0 ? Math.min(limitPages, pages.length) : pages.length;
  return pages
    .slice(0, cap)
    .map((pageText, idx) => `# Página ${idx + 1}\n${pageText.trim()}\n`)
    .join("\n");
}

async function renderPageToBuffer(pdfDocument, pageNumber, scale = DEFAULT_SCALE) {
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toBuffer("image/png");
}

async function rasterizePdf(fileBuffer, { maxPages = DEFAULT_MAX_PAGES, scale = DEFAULT_SCALE } = {}) {
  const loadingTask = pdfjsLib.getDocument({ data: fileBuffer, useSystemFonts: true });
  const pdfDocument = await loadingTask.promise;
  if (pdfDocument.numPages > maxPages) {
    console.warn(
      `[ingest] PDF com ${pdfDocument.numPages} páginas; processando apenas as primeiras ${maxPages}.`
    );
  }
  const pagesCount = Math.min(pdfDocument.numPages, maxPages);
  if (pagesCount === 0) {
    throw new Error("PDF sem páginas processáveis");
  }
  const images = new Array(pagesCount);

  let cursor = 0;
  const workers = Array.from({ length: Math.min(DEFAULT_OCR_CONCURRENCY, pagesCount) }, () =>
    (async () => {
      while (true) {
        const current = cursor;
        cursor += 1;
        if (current >= pagesCount) break;
        const pageIndex = current + 1;
        const buffer = await renderPageToBuffer(pdfDocument, pageIndex, scale);
        images[current] = buffer;
      }
    })()
  );

  await Promise.all(workers);

  return { images, pagesCount };
}

async function runOcrOnImages(images, openai, { model = "gpt-4o-mini", concurrency = DEFAULT_OCR_CONCURRENCY } = {}) {
  const results = new Array(images.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, images.length) }, () =>
    (async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= images.length) break;

        const pageNumber = index + 1;
        const base64 = images[index].toString("base64");
        try {
          const completion = await openai.chat.completions.create({
            model,
            temperature: 0,
            messages: [
              { role: "system", content: OCR_PROMPT },
              {
                role: "user",
                content: [
                  { type: "input_text", text: `Processar página ${pageNumber}` },
                  { type: "input_image", image: { data: base64, mime_type: "image/png" } }
                ]
              }
            ]
          });
          const text = completion.choices[0]?.message?.content?.trim?.() || "";
          results[index] = `# Página ${pageNumber}\n${text}\n`;
        } catch (error) {
          throw new Error(`Falha ao fazer OCR da página ${pageNumber}: ${error.message}`);
        }
      }
    })()
  );

  await Promise.all(workers);

  return results.filter(Boolean).join("\n");
}

export async function extractTextFromPdf(filePath, options = {}) {
  const {
    openai,
    textThreshold = DEFAULT_TEXT_THRESHOLD,
    maxPages = DEFAULT_MAX_PAGES,
    model = "gpt-4o-mini",
    ocrConcurrency = DEFAULT_OCR_CONCURRENCY
  } = options;

  if (!openai) throw new Error("extractTextFromPdf requer instância do OpenAI");

  const fileBuffer = fs.readFileSync(filePath);

  let text = "";
  let pagesCount = 0;
  let rawParsedText = "";
  try {
    const parsed = await pdfParse(fileBuffer);
    rawParsedText = parsed.text || "";
    const reportedPages = parsed.numpages || rawParsedText.split(/\f/g).length;
    pagesCount = Math.min(reportedPages || 0, maxPages);
    text = rawParsedText.trim();
  } catch (err) {
    console.warn(`[ingest] Falha no pdf-parse: ${err.message}`);
  }

  if (text && text.length >= textThreshold) {
    const normalized = normalizeParsedText(rawParsedText || text, pagesCount || maxPages).trim();
    const totalPages = pagesCount || normalized.split(/# Página /g).filter(Boolean).length;
    return { text: normalized, pagesCount: totalPages || 1, ocrUsed: false };
  }

  console.log("[ingest] Conteúdo textual insuficiente; ativando OCR com visão");
  const { images, pagesCount: rasterPages } = await rasterizePdf(fileBuffer, { maxPages });
  const structured = await runOcrOnImages(images, openai, { model, concurrency: ocrConcurrency });
  return { text: structured.trim(), pagesCount: rasterPages, ocrUsed: true };
}

// Gerador minimalista de PDF de página única (texto ASCII), sem dependências.
//
// Por que existe: o harness precisa subir um "enunciado" e um "trabalho do
// aluno" reais para o sistema rodar o fluxo completo (PrepBuilder manda os dois
// PDFs pra OpenAI montar o plano da entrevista). Não precisamos de layout bonito
// — só de um PDF VÁLIDO com texto EXTRAÍVEL. Mantemos o texto em ASCII (sem
// acentos) para evitar dor de cabeça com encoding de fontes; o conteúdo
// semântico é preservado. A entrevista em si (TTS/STT) lida com acentos
// normalmente — só a fonte dos PDFs é ASCII.

function escapePdfText(s) {
    return String(s)
        // Remove acentos comuns -> ASCII (extração limpa, sem WinAnsi).
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        // Qualquer não-ASCII restante vira espaço.
        .replace(/[^\x20-\x7e]/g, " ")
        // Escapes obrigatórios do PDF.
        .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// Quebra parágrafos longos em linhas de ~90 chars (cabem na largura A4 a 11pt).
function wrap(paragraphs, maxChars = 90) {
    const lines = [];
    for (const para of paragraphs) {
        if (para === "") { lines.push(""); continue; }
        const words = String(para).split(/\s+/);
        let cur = "";
        for (const w of words) {
            if ((cur + " " + w).trim().length > maxChars) {
                lines.push(cur);
                cur = w;
            } else {
                cur = (cur + " " + w).trim();
            }
        }
        if (cur) lines.push(cur);
    }
    return lines;
}

// Constrói um PDF de 1+ páginas a partir de parágrafos. Retorna Buffer.
export function makePdf(title, paragraphs) {
    const allLines = wrap([title, "", ...paragraphs]);

    // Paginação simples: ~48 linhas por página A4 a leading 15.
    const LINES_PER_PAGE = 48;
    const pages = [];
    for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) {
        pages.push(allLines.slice(i, i + LINES_PER_PAGE));
    }
    if (pages.length === 0) pages.push([title]);

    // Monta os objetos. Layout de objetos:
    //   1: Catalog
    //   2: Pages
    //   3: Font
    //   para cada página p (0-based): contentObj = 4 + 2*p, pageObj = 5 + 2*p
    const objects = [];
    const pageObjNums = [];
    pages.forEach((lines, p) => {
        const contentNum = 4 + 2 * p;
        const pageNum = 5 + 2 * p;
        pageObjNums.push(pageNum);

        let stream = "BT\n/F1 11 Tf\n15 TL\n72 770 Td\n";
        lines.forEach((ln, idx) => {
            if (idx > 0) stream += "T*\n";
            stream += `(${escapePdfText(ln)}) Tj\n`;
        });
        stream += "ET";

        objects[contentNum] = `${contentNum} 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream\nendobj\n`;
        objects[pageNum] = `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj\n`;
    });

    objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
    objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map(n => `${n} 0 R`).join(" ")}] /Count ${pageObjNums.length} >>\nendobj\n`;
    objects[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

    // Serializa com xref correto.
    let pdf = "%PDF-1.4\n";
    const offsets = [];
    const maxNum = objects.length - 1;
    for (let n = 1; n <= maxNum; n++) {
        if (!objects[n]) continue;
        offsets[n] = Buffer.byteLength(pdf, "latin1");
        pdf += objects[n];
    }
    const xrefStart = Buffer.byteLength(pdf, "latin1");
    const count = maxNum + 1;
    pdf += `xref\n0 ${count}\n`;
    pdf += "0000000000 65535 f \n";
    for (let n = 1; n <= maxNum; n++) {
        if (offsets[n] == null) {
            pdf += "0000000000 65535 f \n";
        } else {
            pdf += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
        }
    }
    pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    return Buffer.from(pdf, "latin1");
}

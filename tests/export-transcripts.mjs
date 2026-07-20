// Exporta transcripts de entrevistas em pastas com rótulos CEGOS, para
// avaliação qualitativa por humanos ou IAs externas sem viés de rótulo.
// Inclui intro, perguntas do plano, intervenções (follow-ups/dicas/meta) na
// ordem cronológica, justificativas internas e encerramento.
//
// Uso: WORKS="token1=rotulo-A,token2=rotulo-B" [OUT=dir] node -r dotenv/config tests/export-transcripts.mjs
//   WORKS  obrigatório: pares work_token=rótulo-cego separados por vírgula.
//   OUT    default: tests/runs-text/transcripts-cegos
// O gabarito (rótulo → token) é gravado em OUT/gabarito-modelos.txt.
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const OUT = process.env.OUT || "tests/runs-text/transcripts-cegos";
const pairs = String(process.env.WORKS || "").split(",").map(s => s.trim()).filter(Boolean)
    .map(p => { const [work, blind] = p.split("="); return { work: work?.trim(), blind: blind?.trim() }; });
if (!pairs.length || pairs.some(p => !p.work || !p.blind)) {
    console.error('Uso: WORKS="token=rotulo,token=rotulo" node -r dotenv/config tests/export-transcripts.mjs');
    process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const TYPE_LABEL = { follow_up: "follow-up", hint: "dica", meta_modal: "resposta meta (modal)", ask_repeat: "pedido de repetição" };

function mdTranscript(cj) {
    const L = [];
    L.push(`# ${cj.student_label}`, "");
    L.push("## Introdução", "");
    for (const m of cj.intro?.messages || []) L.push(`**${m.role === "assistant" ? "Entrevistador" : "Aluno"}:** ${m.content}`, "");
    L.push("## Entrevista", "");
    for (const t of cj.turns || []) {
        L.push(`### Pergunta ${t.index + 1} do plano`);
        L.push(`**Entrevistador:** ${t.question}`, "");
        if (t.rationale) L.push(`> _justificativa interna (invisível ao aluno): ${t.rationale}_`, "");
        for (const iv of t.interventions || []) {
            L.push(`**Aluno:** ${iv.student_message}`, "");
            const tag = TYPE_LABEL[iv.type] || iv.type;
            const reason = iv.follow_up_reason ? `, motivo: ${iv.follow_up_reason}` : "";
            L.push(`**Entrevistador (${tag}${reason}):** ${iv.assistant_response}`, "");
            if (iv.rationale) L.push(`> _justificativa interna: ${iv.rationale}_`, "");
        }
        L.push(`**Aluno (resposta que encerrou a pergunta):** ${t.answer ?? "(sem resposta)"}`, "");
    }
    if (cj.finalization?.message) L.push("## Encerramento", "", `**Entrevistador:** ${cj.finalization.message}`, "");
    return L.join("\n");
}

// Sem rm recursivo do diretório: o Dropbox segura handles (EBUSY). Os nomes
// são determinísticos; sobrescrever basta.
for (const { work, blind } of pairs) {
    const dir = path.join(OUT, blind);
    fs.mkdirSync(dir, { recursive: true });
    const { rows } = await pool.query(
        `SELECT s.student_label, s.conversation_json FROM submissions s JOIN works w ON w.id=s.work_id WHERE w.work_token=$1 ORDER BY s.student_label`, [work]);
    if (!rows.length) { console.error(`AVISO: trabalho ${work} sem submissões`); continue; }
    let ivTotal = 0;
    for (const r of rows) {
        const cj = JSON.parse(r.conversation_json);
        ivTotal += (cj.turns || []).reduce((s, t) => s + (t.interventions?.length || 0), 0);
        const n = (r.student_label.match(/\d+/) || ["00"])[0];
        fs.writeFileSync(path.join(dir, `aluno-${n}.md`), mdTranscript(cj), "utf8");
    }
    console.log(`${blind}: ${rows.length} transcripts, ${ivTotal} intervenções (work ${work})`);
}
fs.writeFileSync(path.join(OUT, "gabarito-modelos.txt"),
    "NAO ABRIR ANTES DE CONCLUIR A AVALIACAO (quebra o protocolo cego).\n\n" +
    pairs.map(p => `${p.blind} = work_token ${p.work}`).join("\n") + "\n", "utf8");
console.log("gabarito gravado em", path.join(OUT, "gabarito-modelos.txt"));
await pool.end();

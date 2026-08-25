// E2E do CORTE 4 na ENTREVISTA REALTIME: sessão de voz completa (robô no relay,
// reusa tests/live-ending-e2e.mjs) e, por cima, as verificações do corte 4A:
// conversation_json, retranscrição da fila (final_transcript + quality),
// revisão do aluno (transcript + auditoria + comentário) e avaliação
// (o avaliador recebe o bloco de auditoria).
//
// CUSTO/OPT-IN (~US$0,6: prep + sessão realtime + avaliação):
//   RUN_LIVE_E2E=1 node -r dotenv/config tests/live-corte4-e2e.mjs
import { spawn } from "node:child_process";
import { seed } from "./audio-e2e/seed.mjs";
import { makePdf } from "./audio-e2e/pdfgen.mjs";
import * as db from "../lib/db.js";

if (process.env.RUN_LIVE_E2E !== "1") { console.error("use RUN_LIVE_E2E=1 (gera custo ~US$0,6)"); process.exit(2); }
const BASE = process.env.E2E_BASE_HTTP || "http://127.0.0.1:5000";
const report = { ok: true };
const pass = (k, x) => console.log(`✓ ${k}`, x ? JSON.stringify(x).slice(0, 160) : "");
const fail = (k, m) => { report.ok = false; console.log(`✗ ${k} — ${m}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 1. Seed do professor (mesmo do audio-e2e) + vira variante REALTIME.
const s = await seed({ base: BASE, questionCount: 3, label: "Live corte4" });
const workRow = await db.getWorkByToken(s.workToken);
await db.setWorkInterviewVariant(workRow.id, "realtime");
pass("seed", { work: s.workToken, sub: s.subToken });

// 2. Aluno: consentimento + upload do PDF do trabalho -> prep em background.
await fetch(`${BASE}/s/${s.subToken}/live/consent`, { method: "POST" });
{
    const pdf = makePdf("Relatorio: Microcentros de Distribuicao Urbana", [
        "Proponho uma rede de tres microcentros alugados em galpoes pequenos, proximos as",
        "zonas de maior densidade de entregas, operando com bicicletas eletricas de carga.",
        "Custo estimado: R$ 180 mil de implantacao e R$ 45 mil mensais de operacao.",
        "A ultima milha cai de 38% para 22% do custo total por pacote entregue.",
        "Riscos: sazonalidade da demanda, furto de carga e resistencia dos condominios.",
        "Metricas: custo por pacote, tempo medio de entrega e taxa de sucesso na primeira tentativa.",
    ]);
    const fd = new FormData();
    fd.append("file", new Blob([pdf], { type: "application/pdf" }), "trabalho.pdf");
    const r = await (await fetch(`${BASE}/s/${s.subToken}/live/upload`, { method: "POST", body: fd })).json();
    if (r.error) { fail("upload", JSON.stringify(r)); process.exit(1); }
}
let prep = null;
for (let i = 0; i < 60; i++) {
    await sleep(3000);
    prep = await (await fetch(`${BASE}/s/${s.subToken}/live/prep-status`)).json();
    if (prep.status === "ready" || prep.prep_status === "ready") break;
    if (prep.status === "error" || prep.prep_status === "error") break;
}
if ((prep?.status || prep?.prep_status) === "ready") pass("prep", {});
else { fail("prep", JSON.stringify(prep)); process.exit(1); }

// 3. Sessão de voz completa (robô do live-ending-e2e).
const code = await new Promise((res) => {
    const p = spawn(process.execPath, ["-r", "dotenv/config", "tests/live-ending-e2e.mjs", s.subToken], { stdio: "inherit" });
    p.on("close", res);
});
if (code === 0) pass("voice_session", {});
else fail("voice_session", `exit=${code}`);

// 3b. Vídeo obrigatório (ADR 0005): sem ele a entrevista fica 'awaiting_video'
// e a revisão devolve not_finalized — sobe um webm de teste como o navegador.
{
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const vp = path.join(os.tmpdir(), "e2e-live-video.webm");
    if (!fs.existsSync(vp)) {
        await new Promise((res, rej) => {
            const ff = spawn("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=5",
                "-f", "lavfi", "-i", "sine=frequency=300:duration=3", "-c:v", "libvpx", "-c:a", "libopus", "-y", vp]);
            ff.on("close", c => c === 0 ? res() : rej(new Error(`ffmpeg exit=${c}`)));
        });
    }
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(vp)], { type: "video/webm" }), "video.webm");
    const r = await (await fetch(`${BASE}/s/${s.subToken}/live/video`, { method: "POST", body: fd })).json();
    if (r.ok) pass("video_upload", {});
    else fail("video_upload", JSON.stringify(r));
}

const subRow = await db.findSubmissionByToken(s.subToken);

// 4. conversation_json com turnos e canal realtime.
const convText = await db.getConversationJson(subRow.id);
let conv = null; try { conv = JSON.parse(convText); } catch {}
if (conv?.channel === "realtime_voice" && conv.turns?.length >= 1) pass("conversation_json", { turns: conv.turns.length });
else fail("conversation_json", `channel=${conv?.channel} turns=${conv?.turns?.length}`);

// 5. Retranscrição da fila (tique ~60s) com quality.
let ft = null;
for (let i = 0; i < 30 && !ft; i++) { await sleep(4000); ft = await db.getFinalTranscript(subRow.id); }
if (ft?.text && ft.quality) pass("final_transcript", { mode: ft.mode, quality: ft.quality });
else fail("final_transcript", ft ? "sem quality" : "não apareceu em 120s");

// 6. Revisão do aluno: conversa + auditoria + comentário aberto.
const rv = await (await fetch(`${BASE}/s/${s.subToken}/review`)).json();
if (rv.conversation?.turns?.length && rv.audit_transcript?.text && rv.comment && !rv.comment.locked) {
    pass("student_review", { audit_mode: rv.audit_transcript.mode });
} else fail("student_review", JSON.stringify({ turns: rv.conversation?.turns?.length, audit: !!rv.audit_transcript, err: rv.error }));

// 7. Avaliação (rota do professor da entrevista) — o avaliador recebe o bloco
// de auditoria via evaluationOps; sucesso aqui = integração inteira de pé.
const ev = await (await fetch(`${BASE}/w/${s.workToken}/submissions/${s.subToken}/evaluation`, { method: "POST" })).json();
if (ev?.evaluation?.overall?.defense_quality) pass("evaluate", { defense: ev.evaluation.overall.defense_quality });
else fail("evaluate", JSON.stringify(ev).slice(0, 200));

console.log(report.ok ? "\n✅ LIVE CORTE4 PASS" : "\n❌ LIVE CORTE4 FAIL");
process.exit(report.ok ? 0 : 1);

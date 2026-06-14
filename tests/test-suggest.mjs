// Valida o endpoint POST /s/:token/suggest-answer (sugestão de resposta em
// conversa de TESTE): gating 403 em não-teste, geração de texto ancorada, e
// geração de áudio (want_audio) em modo áudio. Requer o servidor no ar.
// Uso: node tests/test-suggest.mjs [--base http://127.0.0.1:5099]
import "dotenv/config";
import { seed } from "./audio-e2e/seed.mjs";

const argv = process.argv.slice(2);
const BASE = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "http://127.0.0.1:5099";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "ok   " : "FAIL ") + msg); if (!cond) fails++; };

async function suggest(token, body) {
    const r = await fetch(`${BASE}/s/${token}/suggest-answer`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    let j = {};
    try { j = await r.json(); } catch {}
    return { status: r.status, j };
}

async function main() {
    console.log(`[base] ${BASE}`);
    const s = await seed({ base: BASE, voice: "coral", questionCount: 3 });

    // 1) GATING: a submissão do seed é NÃO-teste. /start + /suggest → 403.
    await fetch(`${BASE}/s/${s.subToken}/start`, { method: "POST" });
    const gate = await suggest(s.subToken, { profile: "domina" });
    ok(gate.status === 403, `gating: não-teste responde 403 (got ${gate.status})`);

    // 2) Cria submissão is_test no mesmo work (modo áudio).
    const subR = await fetch(`${BASE}/w/${s.workToken}/submissions`, {
        method: "POST", headers: { "Content-Type": "application/json", ...s.jar.header() },
        body: JSON.stringify({ label: "suggest-test", is_test: true }),
    });
    const { submissions } = await subR.json();
    const tk = submissions?.[0]?.submission_token;
    ok(!!tk, `submissão is_test criada (${tk})`);

    // /start + /upload (dispara o PrepBuilder → work_analysis).
    await fetch(`${BASE}/s/${tk}/start`, { method: "POST" });
    const fd = new FormData();
    fd.append("file", new Blob([s.trabalhoPdf], { type: "application/pdf" }), "trabalho.pdf");
    const up = await fetch(`${BASE}/s/${tk}/upload`, { method: "POST", body: fd });
    ok(up.ok, `upload da submissão de teste (status ${up.status})`);
    await sleep(8000); // dá tempo do work_analysis ficar pronto para ancorar.

    // 3) Sugestão de texto (perfil contradiz — exercita a ancoragem).
    const txt = await suggest(tk, { profile: "contradiz" });
    ok(txt.status === 200 && typeof txt.j.text === "string" && txt.j.text.length > 0,
        `sugestão de texto: "${(txt.j.text || JSON.stringify(txt.j)).slice(0, 90)}"`);

    // 4) Sugestão de áudio (want_audio) — modo áudio gera TTS.
    const aud = await suggest(tk, { profile: "domina", want_audio: true });
    ok(aud.status === 200 && aud.j.text && (aud.j.audio_base64 || aud.j.audio_error),
        `sugestão de áudio: text=${!!aud.j.text} audio=${!!aud.j.audio_base64} err=${!!aud.j.audio_error}`);

    console.log(`\nwork_token de teste: ${s.workToken} (confira spent_usd no banco)`);
    console.log(fails ? `\nFALHAS: ${fails}` : `\nENDPOINT OK`);
    process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(2); });

// E2E do ENCERRAMENTO da prova oral: um aluno-robô (TTS→PCM em ritmo real)
// faz a prova inteira contra o relay local e verifica o requisito central:
// a prova TERMINA COM FALA AUDÍVEL (despedida) antes do wrapup.
// Uso: node -r dotenv/config tests/oral-ending-e2e.mjs  (servidor local no ar).
// Config por env (como os outros E2E orais): E2E_BASE_HTTP, E2E_BASE_WS e
// E2E_WORK_TOKEN (um trabalho oral de teste) — permite rodar fora da porta 5000.
import { WebSocket } from "ws";
import OpenAI from "openai";
import { synthesizeSpeech } from "../lib/audio.js";

const BASE = process.env.E2E_BASE_HTTP || "http://127.0.0.1:5000";
const WS_BASE = process.env.E2E_BASE_WS || "ws://127.0.0.1:5000";
const WT = process.env.E2E_WORK_TOKEN || "2be0f4312c89"; // trabalho oral de teste (override por env)
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
const say = (m) => console.log(`[${ts()}] ${m}`);

// 1) submissão de TESTE
const mint = await (await fetch(`${BASE}/w/${WT}/submissions`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ labels: ["robo-encerramento"], is_test: true }),
})).json();
const sub = mint?.submissions?.[0]?.submission_token;
if (!sub) { console.log("mint falhou:", JSON.stringify(mint)); process.exit(1); }
say(`submission ${sub}`);
await fetch(`${BASE}/s/${sub}/oral/consent`, { method: "POST" });

// 2) respostas do robô (conteúdo genérico do domínio; qualidade é irrelevante
// para o teste — o que importa é a prova fluir e ENCERRAR falando)
const ANSWERS = [
  "O ponto central é que cada bloco guarda o hash do bloco anterior, formando uma corrente encadeada. Qualquer alteração quebra os hashes seguintes, e é isso que dá integridade ao histórico.",
  "O protocolo ajusta a dificuldade a cada duas mil e dezesseis blocos, mirando uma média de dez minutos por bloco. Se a rede minera rápido demais, o alvo fica mais difícil; se demora, fica mais fácil.",
  "No total serão vinte e um milhões de bitcoins, com a emissão caindo pela metade a cada halving. Esse teto existe para garantir escassez e previsibilidade da política monetária.",
  "Acho que o essencial é a prova de trabalho: gastar energia para achar um hash abaixo do alvo, o que torna caro fraudar e barato verificar, obrigado.",
];
say("sintetizando as falas do robô...");
const pcms = [];
for (const a of ANSWERS) pcms.push(await synthesizeSpeech(client, "gpt-4o-mini-tts", a, "ash", "pcm"));
const EXTRA = await synthesizeSpeech(client, "gpt-4o-mini-tts", "Era só isso mesmo, não tenho mais nada a acrescentar, obrigado.", "ash", "pcm");

// 3) sessão de voz
const ws = new WebSocket(`${WS_BASE}/s/${sub}/oral/relay`);
const FRAME = 4800; // 100ms @ PCM16 24kHz
const SIL = Buffer.alloc(FRAME);
let q = null, qp = 0, speaking = false, spoken = 0;
let lastExAt = 0, exSinceMyTurn = false, afterMyBytes = 0, myLastDoneAt = 0;
let wrapup = false;

ws.on("open", () => say("ws aberto — prova começando"));
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    lastExAt = Date.now(); exSinceMyTurn = true;
    if (myLastDoneAt) afterMyBytes += data.length; // áudio do examinador APÓS minha última fala
    return;
  }
  let m; try { m = JSON.parse(data.toString()); } catch { return; }
  if (m.type === "ka") return;
  say(`evento: ${JSON.stringify(m)}`);
  if (m.type === "wrapup") {
    wrapup = true;
    // deixa o áudio restante chegar, então encerra limpo (bye)
    setTimeout(() => {
      try { ws.send(JSON.stringify({ type: "bye" })); } catch {}
      setTimeout(() => { try { ws.close(); } catch {} }, 800);
    }, 2500);
  }
});

// bomba de áudio contínua: silêncio (como um mic real) ou a fala da vez
const pump = setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (q) {
    const chunk = q.subarray(qp, qp + FRAME);
    ws.send(chunk.length ? chunk : SIL);
    qp += FRAME;
    if (qp >= q.length) { q = null; speaking = false; myLastDoneAt = Date.now(); afterMyBytes = 0; say(`fala ${spoken} concluída`); }
  } else ws.send(SIL);
}, 100);

// cérebro: quando o examinador silencia por ~2,5s, responde
const brain = setInterval(() => {
  if (wrapup || speaking || !exSinceMyTurn) return;
  if (lastExAt && Date.now() - lastExAt > 2500) {
    exSinceMyTurn = false;
    const pcm = spoken < pcms.length ? pcms[spoken] : (spoken < 8 ? EXTRA : null);
    if (!pcm) return;
    spoken++;
    q = pcm; qp = 0; speaking = true;
    say(`falando resposta ${spoken} (${(pcm.length / 48000).toFixed(1)}s)`);
  }
}, 250);

ws.on("close", () => {
  clearInterval(pump); clearInterval(brain);
  const farewellSecs = (afterMyBytes / 48000).toFixed(1);
  say(`ws fechado. wrapup=${wrapup} falas=${spoken} audio_do_examinador_apos_minha_ultima_fala=${farewellSecs}s`);
  console.log(`\nVEREDITO: ${wrapup && afterMyBytes >= 24000 ? "PASS — prova terminou com fala audível" : "FAIL — fim sem fala suficiente"}`);
  process.exit(wrapup && afterMyBytes >= 24000 ? 0 : 1);
});
ws.on("error", (e) => { say(`ws error: ${e.message}`); });

setTimeout(() => { say("TIMEOUT GERAL (6min)"); try { ws.close(); } catch {} setTimeout(() => process.exit(2), 500); }, 360000);

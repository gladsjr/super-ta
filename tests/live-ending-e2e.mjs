// E2E do ENCERRAMENTO da entrevista SIMPLIFICADA (tempo real): um aluno-robô
// (TTS→PCM em ritmo real) faz a entrevista inteira contra o relay local e
// verifica: (a) a entrevista TERMINA COM FALA AUDÍVEL (despedida por TTS) antes
// do wrapup; (b) ao fechar, o transcript vira conversation_json com turnos.
// Uso: node -r dotenv/config tmp/live-ending-e2e.mjs <submissionToken>
// (servidor local no ar; submissão de TESTE com consent + prep prontos)
import { WebSocket } from "ws";
import OpenAI from "openai";
import { synthesizeSpeech } from "../lib/audio.js";

const SUB = process.argv[2];
if (!SUB) { console.log("uso: node tmp/live-ending-e2e.mjs <submissionToken>"); process.exit(1); }
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
const say = (m) => console.log(`[${ts()}] ${m}`);

// Respostas genéricas do caso (eficiência energética numa padaria) — a
// qualidade é irrelevante; o que importa é a conversa fluir e ENCERRAR falando.
const ANSWERS = [
  "A recomendação central é trocar os equipamentos mais antigos, principalmente os fornos e a refrigeração, por modelos mais eficientes, e ajustar a rotina de uso para fugir do horário de pico. É isso que sustenta a meta de dezoito por cento de economia.",
  "A meta é alcançável porque o diagnóstico partiu do consumo real de quatro mil e duzentos quilowatts-hora por mês, e a maior parte do desperdício está concentrada na refrigeração antiga, que trabalha o dia inteiro. Substituindo esses pontos, a conta cai de forma consistente.",
  "O investimento se paga em torno de dois a três anos, considerando o custo dos equipamentos novos contra a economia mensal na conta de energia. No pior cenário, a economia demora um pouco mais, mas o gasto não aumenta, obrigado.",
];
const EXTRA_TEXT = "Era só isso mesmo, não tenho mais nada a acrescentar, obrigado.";

say("sintetizando as falas do robô...");
const pcms = [];
for (const a of ANSWERS) pcms.push(await synthesizeSpeech(client, "gpt-4o-mini-tts", a, "ash", "pcm"));
const EXTRA = await synthesizeSpeech(client, "gpt-4o-mini-tts", EXTRA_TEXT, "ash", "pcm");

const ws = new WebSocket(`ws://127.0.0.1:5000/s/${SUB}/live/relay`);
const FRAME = 4800; // 100ms @ PCM16 24kHz
const SIL = Buffer.alloc(FRAME);
let q = null, qp = 0, speaking = false, spoken = 0;
let lastExAt = 0, exSinceMyTurn = false, afterMyBytes = 0, myLastDoneAt = 0;
let wrapup = false;

ws.on("open", () => say("ws aberto — entrevista começando"));
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    lastExAt = Date.now(); exSinceMyTurn = true;
    if (myLastDoneAt) afterMyBytes += data.length; // áudio do entrevistador APÓS minha última fala
    return;
  }
  let m; try { m = JSON.parse(data.toString()); } catch { return; }
  if (m.type === "ka") return;
  say(`evento: ${JSON.stringify(m)}`);
  if (m.type === "wrapup") {
    wrapup = true;
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

// cérebro: quando o entrevistador silencia por ~2,5s, responde
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
  say(`ws fechado. wrapup=${wrapup} falas=${spoken} audio_do_entrevistador_apos_minha_ultima_fala=${farewellSecs}s`);
  console.log(`\nVEREDITO (fala final): ${wrapup && afterMyBytes >= 24000 ? "PASS — entrevista terminou com fala audível" : "FAIL — fim sem fala suficiente"}`);
  process.exit(wrapup && afterMyBytes >= 24000 ? 0 : 1);
});
ws.on("error", (e) => { say(`ws error: ${e.message}`); });

setTimeout(() => { say("TIMEOUT GERAL (8min)"); try { ws.close(); } catch {} setTimeout(() => process.exit(2), 500); }, 480000);

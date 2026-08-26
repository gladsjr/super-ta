// FALLBACK do gerador de áudios do sound check guiado por voz (#321).
//
// Os mp3 CANÔNICOS em static/audio/soundcheck/ são da voz "Voz C — ORATIA" do
// HeyGen (Cartesia), gerados manualmente pela UI (a conta não tem créditos de
// API). Convenção de pronúncia na locução do HeyGen: grafar "Orátia" e "iá";
// nos roteiros de lib/soundCheck.js (referência de vazamento + legenda) fica a
// grafia da marca ("ORATIA").
//
// Este script sintetiza os MESMOS roteiros na voz OpenAI (SC_VOICE) — use-o só
// como quebra-galho quando um roteiro mudar e o HeyGen não estiver à mão
// (depois substitua pelos áudios da Voz C):
//   node -r dotenv/config scripts/gen-soundcheck-audio.mjs
// Custo: ~10 chamadas de TTS (centavos). Os mp3 são commitados no repo.

import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { SC_SCRIPTS, SC_VOICE } from "../lib/soundCheck.js";
import { synthesizeSpeech } from "../lib/audio.js";
import { TTS_MODEL } from "../lib/config.js";

const OUT = path.join(process.cwd(), "static", "audio", "soundcheck");
fs.mkdirSync(OUT, { recursive: true });
const client = new OpenAI();

for (const [key, text] of Object.entries(SC_SCRIPTS)) {
    const file = path.join(OUT, `${key}.mp3`);
    const buf = await synthesizeSpeech(client, TTS_MODEL, text, SC_VOICE);
    fs.writeFileSync(file, buf);
    console.log(`${key}.mp3  ${(buf.length / 1024).toFixed(0)} KB`);
}
console.log(`ok — ${Object.keys(SC_SCRIPTS).length} áudios em ${OUT} (voz=${SC_VOICE})`);

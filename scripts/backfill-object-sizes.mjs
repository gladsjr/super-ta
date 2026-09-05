// Preenche `object_sizes` para os objetos que subiram antes da migration 080 (#376).
//
// Por que existe: o tamanho passou a ser gravado no UPLOAD, então tudo que já
// estava no storage ficou sem ele — e sem tamanho o vídeo NÃO TOCA (o servidor
// responde 200 sem Content-Length nem Accept-Ranges, e o WebM do MediaRecorder
// precisa de Range para o navegador achar a duração). Em produção eram 78 dos
// 80 vídeos.
//
// O `serveVideo` já mede sob demanda e grava, então isto não é obrigatório —
// é a forma de consertar tudo de uma vez, sem esperar que um professor abra
// cada vídeo. Rode no ambiente ONDE O STORAGE ESTÁ (no Replit, não na máquina
// local: o bucket é de lá).
//
// Uso:
//   node scripts/backfill-object-sizes.mjs --dry-run   # só lista o que falta
//   node scripts/backfill-object-sizes.mjs             # mede e grava
//
// Só LÊ do storage (um HEAD por objeto) e escreve numa tabela de cache. Não
// altera vídeo, submissão nem avaliação. Idempotente: rodar duas vezes seguidas
// não repete trabalho (a segunda não encontra pendências).

import "dotenv/config";
import * as db from "../lib/db.js";
import { objectSize } from "../lib/audioStore.js";
import { pool } from "../auth.js";

const dryRun = process.argv.includes("--dry-run");

// Todas as chaves de vídeo conhecidas: a primeira parte (oral_video_key), as
// partes de retomada (oral_video_parts) e o consolidado da prova oral — cuja
// chave NÃO está em oral_video_parts e por isso escapa de varreduras ingênuas.
// Foi o mesmo detalhe que o #349 teve de tratar.
const { rows } = await pool.query(`
    SELECT DISTINCT chave FROM (
        SELECT oral_video_key AS chave FROM submissions WHERE oral_video_key IS NOT NULL
        UNION ALL
        SELECT jsonb_array_elements_text(oral_video_parts) FROM submissions
         WHERE oral_video_parts IS NOT NULL AND jsonb_array_length(oral_video_parts) > 0
        UNION ALL
        SELECT object_key FROM object_sizes WHERE bytes IS NULL
    ) t WHERE chave IS NOT NULL
`);

const chaves = rows.map(r => r.chave).filter(Boolean);
const pendentes = [];
for (const chave of chaves) {
    const jaTem = await db.getObjectSize(chave);
    if (!Number.isFinite(jaTem) || jaTem <= 0) pendentes.push(chave);
}

console.log(`objetos conhecidos: ${chaves.length}`);
console.log(`sem tamanho registrado: ${pendentes.length}`);
if (!pendentes.length) { console.log("nada a fazer."); await pool.end(); process.exit(0); }

if (dryRun) {
    for (const c of pendentes) console.log(`  [dry-run] mediria ${c}`);
    console.log("\nnada foi gravado (--dry-run).");
    await pool.end();
    process.exit(0);
}

let ok = 0;
const falhas = [];
for (const chave of pendentes) {
    // Falha em um objeto não aborta o lote: o consolidado pode ter sido apagado,
    // uma parte pode ter sumido. Registra e segue.
    try {
        const bytes = await objectSize(chave);
        if (!Number.isFinite(bytes) || bytes <= 0) { falhas.push([chave, "não foi possível medir"]); continue; }
        await db.setObjectSize(chave, bytes);
        console.log(`  ok ${chave} = ${bytes} bytes`);
        ok++;
    } catch (err) {
        falhas.push([chave, err.message]);
    }
}

console.log(`\ngravados: ${ok}`);
if (falhas.length) {
    console.log(`falharam: ${falhas.length}`);
    for (const [c, m] of falhas) console.log(`  ✗ ${c}: ${m}`);
    console.log("\nFalha aqui NÃO é perda: o serveVideo mede sob demanda no primeiro acesso.");
}
await pool.end();

// Análise forense de autoria das RESPOSTAS DO ALUNO numa entrevista ORATIA.
//
// Objetivo: dado o token de um WORK, varrer todas as submissions e reunir
// evidências (e contra-evidências) de que o aluno respondeu à entrevista
// usando uma IA externa (ex.: colar resposta do ChatGPT no modo texto, ou
// ler em voz alta uma resposta gerada no modo áudio).
//
// IMPORTANTE — natureza dos resultados:
//   Isto NÃO prova fraude. Produz SINAIS heurísticos + os sinais que o
//   próprio sistema já registrou (authorship_doubts do PrepBuilder, memory
//   do super-orquestrador). A decisão é humana: leia as transcrições. Há
//   risco real de falso positivo (aluno que digita rápido, que cola as
//   próprias anotações, que escreve formal por hábito) e de falso negativo
//   (uso de IA bem disfarçado não deixa rastro). Ausência de sinal NÃO é
//   prova de inocência.
//
// Read-only: só roda SELECTs. Não altera nada no banco.
//
// Uso (rodar no shell do Replit, onde DATABASE_URL existe):
//   node scripts/detect-ai-answers.mjs <work_token>
//   node scripts/detect-ai-answers.mjs <work_token> --submission=<sub_token>
//   node scripts/detect-ai-answers.mjs <work_token> --html=relatorio.html
//   node scripts/detect-ai-answers.mjs <work_token> --json=dados.json
//
// Sem flags de saída, imprime um resumo no terminal. Com --html/--json,
// grava o arquivo correspondente (transcrições completas no HTML para leitura).

import "dotenv/config";
import fs from "fs";
import { pool } from "../auth.js";
// Limiares, bancos de expressões e medidores vivem em lib/deliverySignals.js
// (fonte única, compartilhada com o InterviewEvaluatorAgent — que recebe os
// mesmos sinais como contexto de forma na avaliação da entrevista).
import {
    TH,
    MD_BULLET, MD_NUMBERED, MD_HEADER, MD_BOLD, MD_CODE, EM_DASH,
    FORMAL_CONNECTORS, DISFLUENCY,
    words, countMatches, secondsBetween, num, median,
    polishScore, writtenRegisterScore,
} from "../lib/deliverySignals.js";

// ---------------------------------------------------------------------
// Análise de um turno respondido
// ---------------------------------------------------------------------
function analyzeTurn(turn, mode, audioByTurn) {
    const answer = typeof turn.answer === "string" ? turn.answer : null;
    if (!answer || !answer.trim()) return null;

    const w = words(answer);
    const chars = answer.length;
    const latency = secondsBetween(turn.asked_at, turn.answered_at);
    const flags = [];
    const polish = polishScore(answer);

    // --- Sinais de FORMATAÇÃO (fortes no modo texto) ---
    const mdHits = [];
    if (MD_BULLET.test(answer)) mdHits.push("bullets");
    if (MD_NUMBERED.test(answer)) mdHits.push("lista numerada");
    if (MD_HEADER.test(answer)) mdHits.push("cabeçalho #");
    if (MD_BOLD.test(answer)) mdHits.push("**negrito**");
    if (MD_CODE.test(answer)) mdHits.push("`código`");
    if (mdHits.length && mode === "text") {
        flags.push({ sev: 2, code: "markdown", msg: `formatação de LLM no texto: ${mdHits.join(", ")}` });
    }
    const emDashes = (answer.match(EM_DASH) || []).length;
    if (emDashes >= 2) flags.push({ sev: 1, code: "em_dash", msg: `${emDashes} travessões "—" (raro em digitação de chat)` });
    const fc = countMatches(answer, FORMAL_CONNECTORS);
    if (fc >= 2) flags.push({ sev: 1, code: "formal", msg: `${fc} conectivos de prosa expositiva formal` });

    // --- Sinais de TEMPO / VELOCIDADE ---
    let cps = null, wps = null;
    if (mode === "text" && latency != null && latency > 0) {
        cps = chars / latency;
        if (cps >= TH.PASTE_CPS && chars >= TH.PASTE_MIN_CHARS) {
            flags.push({ sev: 3, code: "paste", msg: `${cps.toFixed(1)} car/s em ${chars} caracteres → velocidade de COLAGEM (humano ~3-12 car/s)` });
        }
        if (latency >= TH.LONG_LATENCY_S && w >= TH.LONG_ANSWER_WORDS && polish >= 0.4) {
            flags.push({ sev: 2, code: "delay_then_polished", msg: `${Math.round(latency)}s de espera e então resposta longa e polida (${w} palavras) — tempo compatível com consulta externa` });
        }
    }

    // --- Áudio: ritmo de fala + registro escrito + disfluências ---
    const audio = audioByTurn.get(turn.index);
    if (mode === "audio" && audio && num(audio.duration_s)) {
        const dur = num(audio.duration_s);
        if (dur > 0) {
            wps = w / dur;
            if (wps >= TH.FAST_SPEECH_WPS && w >= 25) {
                flags.push({ sev: 1, code: "fast_speech", msg: `${wps.toFixed(2)} palavras/s (${w} palavras em ${dur}s) — ritmo alto/estável, compatível com leitura` });
            }
        }
    }
    if (mode === "audio") {
        const dis = countMatches(answer, DISFLUENCY);
        const wr = writtenRegisterScore(answer);
        if (w >= 40 && dis === 0 && wr >= 0.4) {
            flags.push({ sev: 2, code: "no_disfluency", msg: `resposta falada longa (${w} palavras) com ZERO marcador de fala espontânea e registro escrito (score ${wr.toFixed(2)}) — compatível com leitura de texto pronto` });
        }
        if (latency != null && latency >= TH.LONG_LATENCY_S && w >= TH.LONG_ANSWER_WORDS) {
            flags.push({ sev: 1, code: "audio_delay", msg: `${Math.round(latency)}s antes de uma resposta longa — tempo para gerar em LLM externo e ler` });
        }
    }

    const nFollow = Array.isArray(turn.interventions) ? turn.interventions.length : 0;

    return {
        index: turn.index,
        question: turn.question || "",
        answer,
        words: w,
        chars,
        latency_s: latency,
        cps,
        wps,
        polish,
        interventions: nFollow,
        flags,
        severity: flags.reduce((a, f) => a + f.sev, 0),
    };
}

// ---------------------------------------------------------------------
// Análise de uma submission inteira
// ---------------------------------------------------------------------
function analyzeSubmission(sub) {
    const conv = parseMaybeJson(sub.conversation_json);
    const rs = parseMaybeJson(sub.runtime_state_json);
    const mode = sub.frozen_interaction_mode
        || conv?.frozen_interaction_mode
        || "text";

    const audioByTurn = new Map();
    for (const a of sub.audio || []) {
        if (a.turn_index != null && !audioByTurn.has(a.turn_index)) audioByTurn.set(a.turn_index, a);
    }

    const turns = Array.isArray(conv?.turns) ? conv.turns : [];
    const analyzed = turns.map(t => analyzeTurn(t, mode, audioByTurn)).filter(Boolean);

    // Mudança de registro DENTRO do aluno: respostas muito mais polidas que a
    // própria mediana sugerem uso seletivo de IA nas perguntas difíceis.
    const polishes = analyzed.map(t => t.polish);
    const medPolish = median(polishes);
    for (const t of analyzed) {
        if (t.polish - medPolish >= 0.4 && t.polish >= 0.5) {
            t.flags.push({ sev: 1, code: "register_shift", msg: `muito mais estruturada que a mediana do próprio aluno (${t.polish.toFixed(2)} vs ${medPolish.toFixed(2)})` });
            t.severity += 1;
        }
    }

    // Sinais que o PRÓPRIO sistema já registrou.
    const wa = rs?.super_orchestrator?.work_analysis || null;
    const memory = rs?.super_orchestrator?.memory || null;
    const systemSignals = {
        authorship_doubts: wa?.assessment?.authorship_doubts || [],
        internal_contradictions: wa?.assessment?.internal_contradictions || [],
        critical_points: wa?.assessment?.critical_points || [],
        memory_open_threads: memory?.open_threads || [],
        memory_free_notes: memory?.free_notes || null,
    };

    const totalSeverity = analyzed.reduce((a, t) => a + t.severity, 0);
    const flaggedTurns = analyzed.filter(t => t.severity > 0);

    return {
        submission_token: sub.submission_token,
        student_label: sub.student_label,
        mode,
        status: sub.status,
        completion_reason: sub.completion_reason,
        completed_at: sub.completed_at,
        created_at: sub.created_at,
        n_turns: analyzed.length,
        turns: analyzed,
        flaggedTurns,
        totalSeverity,
        systemSignals,
        // Verdict heurístico: SÓ um agrupador para priorizar leitura humana.
        verdict: classify(totalSeverity, flaggedTurns.length, systemSignals),
    };
}

function classify(sev, nFlagged, sys) {
    const sysHits = (sys.authorship_doubts.length || 0) + (sys.internal_contradictions.length || 0);
    if (sev >= 6 || (sev >= 3 && sysHits >= 2)) return "ALTA suspeita — revisar com prioridade";
    if (sev >= 3 || nFlagged >= 2 || sysHits >= 1) return "MÉDIA — vale uma leitura atenta";
    if (sev >= 1) return "BAIXA — um ou outro sinal isolado";
    return "Sem sinais automáticos";
}

// ---------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------
function parseMaybeJson(v) {
    if (v == null) return null;
    if (typeof v === "object") return v;
    if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
    return null;
}
function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------------
// Acesso a dados (read-only)
// ---------------------------------------------------------------------
async function fetchData(workToken, onlySub) {
    const wr = await pool.query(
        `SELECT id, work_token, name, interaction_mode, question_count
         FROM works WHERE work_token = $1`,
        [workToken]
    );
    if (wr.rowCount === 0) throw new Error(`work_token não encontrado: ${workToken}`);
    const work = wr.rows[0];

    const params = [work.id];
    let where = "s.work_id = $1";
    if (onlySub) { params.push(onlySub); where += " AND s.submission_token = $2"; }

    const sr = await pool.query(
        `SELECT s.id, s.submission_token, s.student_label,
                s.conversation_json, s.runtime_state_json,
                s.frozen_interaction_mode, s.completion_reason, s.completed_at, s.created_at,
                CASE WHEN s.student_pdf IS NOT NULL OR s.conversation_json IS NOT NULL
                     THEN 'in_progress' ELSE 'pending' END AS status
         FROM submissions s
         WHERE ${where}
         ORDER BY s.created_at ASC, s.id ASC`,
        params
    );

    const subs = sr.rows;
    for (const s of subs) {
        const ar = await pool.query(
            `SELECT audio_idx, turn_index, intervention_index, mimetype, byte_size, duration_s
             FROM student_audio_artifacts WHERE submission_id = $1 ORDER BY audio_idx ASC`,
            [s.id]
        );
        s.audio = ar.rows;
    }
    return { work, subs };
}

// ---------------------------------------------------------------------
// Saídas
// ---------------------------------------------------------------------
function printConsole(work, results) {
    const line = "─".repeat(72);
    console.log(`\n${line}`);
    console.log(`ANÁLISE DE AUTORIA — work "${work.name}" (${work.work_token})`);
    console.log(`Modo configurado: ${work.interaction_mode} | submissions analisadas: ${results.length}`);
    console.log(line);
    console.log(`\n⚠  SINAIS HEURÍSTICOS, NÃO PROVA. Risco de falso positivo/negativo.`);
    console.log(`   Use isto para priorizar QUAIS transcrições ler — a decisão é humana.\n`);

    const order = { "ALTA": 0, "MÉDIA": 1, "BAIXA": 2, "Sem": 3 };
    const sorted = [...results].sort((a, b) =>
        (order[a.verdict.split(" ")[0]] ?? 9) - (order[b.verdict.split(" ")[0]] ?? 9)
        || b.totalSeverity - a.totalSeverity);

    for (const r of sorted) {
        console.log(line);
        console.log(`● ${r.student_label}  [${r.submission_token}]  modo=${r.mode}  status=${r.status}`);
        console.log(`  Veredito heurístico: ${r.verdict}`);
        console.log(`  Turnos respondidos: ${r.n_turns} | turnos com sinal: ${r.flaggedTurns.length} | severidade total: ${r.totalSeverity}`);

        const sys = r.systemSignals;
        if (sys.authorship_doubts.length) {
            console.log(`  ▸ Dúvidas de autoria registradas pelo sistema (PrepBuilder):`);
            sys.authorship_doubts.forEach(d => console.log(`      - ${d}`));
        }
        if (sys.internal_contradictions.length) {
            console.log(`  ▸ Contradições internas na ENTREGA detectadas pelo sistema:`);
            sys.internal_contradictions.forEach(c => console.log(`      - ${typeof c === "string" ? c : (c.description || JSON.stringify(c))}`));
        }
        if (sys.memory_free_notes) console.log(`  ▸ Notas do orquestrador: ${sys.memory_free_notes}`);

        for (const t of r.flaggedTurns) {
            console.log(`  Turno #${t.index} (sev ${t.severity}) — ${t.words} palavras` +
                (t.latency_s != null ? `, ${Math.round(t.latency_s)}s` : "") +
                (t.cps != null ? `, ${t.cps.toFixed(1)} car/s` : "") +
                (t.wps != null ? `, ${t.wps.toFixed(2)} pal/s` : ""));
            t.flags.forEach(f => console.log(`      [${"!".repeat(f.sev)}] ${f.msg}`));
        }
        console.log("");
    }
    console.log(line);
    console.log(`Para ler as transcrições completas com os turnos sinalizados, gere o HTML:`);
    console.log(`  node scripts/detect-ai-answers.mjs ${work.work_token} --html=relatorio.html\n`);
}

function buildHtml(work, results) {
    const order = { "ALTA": 0, "MÉDIA": 1, "BAIXA": 2, "Sem": 3 };
    const sorted = [...results].sort((a, b) =>
        (order[a.verdict.split(" ")[0]] ?? 9) - (order[b.verdict.split(" ")[0]] ?? 9)
        || b.totalSeverity - a.totalSeverity);

    const sevColor = s => s >= 3 ? "#b3261e" : s >= 2 ? "#b06a00" : "#5a5a5a";

    const sections = sorted.map(r => {
        const sys = r.systemSignals;
        const sysHtml = [
            sys.authorship_doubts.length ? `<div class="sys"><b>Dúvidas de autoria (sistema/PrepBuilder):</b><ul>${sys.authorship_doubts.map(d => `<li>${esc(d)}</li>`).join("")}</ul></div>` : "",
            sys.internal_contradictions.length ? `<div class="sys"><b>Contradições internas na entrega:</b><ul>${sys.internal_contradictions.map(c => `<li>${esc(typeof c === "string" ? c : (c.description || JSON.stringify(c)))}</li>`).join("")}</ul></div>` : "",
            sys.critical_points.length ? `<div class="sys"><b>Pontos críticos:</b><ul>${sys.critical_points.map(c => `<li>${esc(c)}</li>`).join("")}</ul></div>` : "",
            sys.memory_free_notes ? `<div class="sys"><b>Notas do orquestrador:</b> ${esc(sys.memory_free_notes)}</div>` : "",
        ].join("");

        const turnsHtml = r.turns.map(t => {
            const flagged = t.severity > 0;
            const flagsHtml = t.flags.map(f => `<span class="flag" style="background:${sevColor(f.sev)}">${esc(f.msg)}</span>`).join(" ");
            const meta = [
                `${t.words} palavras`,
                t.latency_s != null ? `${Math.round(t.latency_s)}s de latência` : null,
                t.cps != null ? `${t.cps.toFixed(1)} car/s` : null,
                t.wps != null ? `${t.wps.toFixed(2)} pal/s (áudio)` : null,
                `polish ${t.polish.toFixed(2)}`,
            ].filter(Boolean).join(" · ");
            return `<div class="turn ${flagged ? "flagged" : ""}">
              <div class="q"><b>P#${t.index}:</b> ${esc(t.question)}</div>
              <div class="a">${esc(t.answer)}</div>
              <div class="meta">${meta}</div>
              ${flagsHtml ? `<div class="flags">${flagsHtml}</div>` : ""}
            </div>`;
        }).join("");

        const vClass = r.verdict.startsWith("ALTA") ? "v-high" : r.verdict.startsWith("MÉDIA") ? "v-med" : r.verdict.startsWith("BAIXA") ? "v-low" : "v-none";
        return `<section class="card">
          <h2>${esc(r.student_label)} <span class="tok">${esc(r.submission_token)}</span></h2>
          <div class="verdict ${vClass}">${esc(r.verdict)}</div>
          <div class="summary">modo=${esc(r.mode)} · status=${esc(r.status)} · turnos=${r.n_turns} · sinalizados=${r.flaggedTurns.length} · severidade=${r.totalSeverity}${r.completion_reason ? " · " + esc(r.completion_reason) : ""}</div>
          ${sysHtml}
          <h3>Transcrição (turnos sinalizados em destaque)</h3>
          ${turnsHtml || "<i>sem turnos respondidos</i>"}
        </section>`;
    }).join("");

    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Análise de autoria — ${esc(work.name)}</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f4f4f5;color:#1a1a1a}
  header{background:#1a1a1a;color:#fff;padding:20px 28px}
  header h1{margin:0 0 4px;font-size:20px}
  .disc{background:#fff8e1;border-left:4px solid #b06a00;padding:12px 16px;margin:18px 28px;border-radius:4px;font-size:14px}
  main{padding:0 28px 60px;max-width:980px}
  .card{background:#fff;border-radius:8px;padding:20px 24px;margin:18px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .card h2{margin:0 0 6px;font-size:18px}
  .tok{font:12px monospace;color:#888;font-weight:normal}
  .verdict{display:inline-block;padding:3px 10px;border-radius:12px;font-size:13px;font-weight:600;margin-bottom:8px}
  .v-high{background:#fde8e6;color:#b3261e}.v-med{background:#fff1de;color:#b06a00}
  .v-low{background:#eef;color:#3b5bb5}.v-none{background:#eef6ee;color:#2e7d32}
  .summary{color:#555;font-size:13px;margin-bottom:10px}
  .sys{background:#f7f7fb;border-left:3px solid #6a5acd;padding:8px 12px;margin:8px 0;border-radius:4px;font-size:14px}
  .sys ul{margin:4px 0 0;padding-left:20px}
  h3{font-size:14px;color:#444;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.04em}
  .turn{padding:10px 12px;border-radius:6px;margin:8px 0;background:#fafafa;border:1px solid #eee}
  .turn.flagged{background:#fff6f5;border-color:#f3c6c0}
  .q{color:#333;margin-bottom:4px}.a{white-space:pre-wrap;color:#111;margin:4px 0}
  .meta{font-size:12px;color:#888;margin-top:4px}
  .flags{margin-top:6px}
  .flag{display:inline-block;color:#fff;font-size:11px;padding:2px 7px;border-radius:10px;margin:2px 4px 2px 0}
</style></head><body>
<header><h1>Análise de autoria das respostas — ${esc(work.name)}</h1>
<div>work_token <code>${esc(work.work_token)}</code> · modo ${esc(work.interaction_mode)} · ${results.length} submissions · gerado ${new Date().toISOString()}</div></header>
<div class="disc"><b>Leia antes de agir.</b> Estes são <b>sinais heurísticos</b>, não prova de fraude.
Servem para priorizar QUAIS transcrições ler — a decisão é humana e exige a leitura completa do diálogo.
Há risco real de <b>falso positivo</b> (aluno que digita rápido, cola as próprias anotações ou escreve formal por hábito)
e de <b>falso negativo</b> (uso de IA bem disfarçado não deixa rastro). Ausência de sinal não prova inocência.</div>
<main>${sections}</main></body></html>`;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
function parseArgs(argv) {
    const out = { _: [] };
    for (const a of argv) {
        const m = a.match(/^--([^=]+)=(.*)$/);
        if (m) out[m[1]] = m[2];
        else if (a.startsWith("--")) out[a.slice(2)] = true;
        else out._.push(a);
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const workToken = args._[0];
    if (!workToken) {
        console.error("Uso: node scripts/detect-ai-answers.mjs <work_token> [--submission=<tok>] [--html=arquivo.html] [--json=arquivo.json]");
        process.exit(2);
    }

    const { work, subs } = await fetchData(workToken.toLowerCase().trim(), args.submission?.toLowerCase()?.trim());
    const withConv = subs.filter(s => s.conversation_json);
    if (withConv.length === 0) {
        console.log(`Nenhuma submission com conversa para o work ${workToken} (${subs.length} submissions, todas sem conversation_json).`);
        return;
    }

    const results = withConv.map(analyzeSubmission);

    if (args.json) {
        fs.writeFileSync(args.json, JSON.stringify({ work, results }, null, 2));
        console.log(`JSON gravado em ${args.json}`);
    }
    if (args.html) {
        fs.writeFileSync(args.html, buildHtml(work, results));
        console.log(`HTML gravado em ${args.html} — abra no navegador para ler as transcrições.`);
    }
    if (!args.json && !args.html) printConsole(work, results);
    else printConsole(work, results); // sempre imprime o resumo também
}

// Exporta a análise pura para testes (sem banco). main() só roda quando o
// script é invocado diretamente pela CLI.
export { analyzeSubmission, analyzeTurn, polishScore, classify };

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
    main()
        .catch(err => { console.error(`✗ ${err.message}`); process.exit(1); })
        .finally(() => pool.end());
}

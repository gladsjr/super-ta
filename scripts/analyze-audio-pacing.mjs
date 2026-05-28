// Analisa ritmo das entrevistas em modo áudio. Para cada turno N→N+1 mede:
//   - student_speak_s    = quanto o aluno falou em N (answer_audio_duration_seconds)
//   - server_latency_s   = turn[N+1].asked_at − turn[N].answered_at (processamento)
//   - interviewer_speak_s = turn[N+1].question_audio_duration_seconds
//
// Compara com um baseline humano hipotético: humano leva pelo menos
// student_speak_s para escutar + interviewer_speak_s para falar a próxima
// pergunta. SuperTA leva server_latency_s + interviewer_speak_s (server
// processa "instantaneamente" em comparação). Quanto mais o SuperTA somar
// menos que o humano, mais rápido o sistema parece — risco de quebrar
// ilusão.
//
// Só read-only. Lê DATABASE_URL do .env.

import "dotenv/config";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const fmt = (n) => (n == null ? "—" : Number(n).toFixed(1).padStart(6));
const fmtS = (n) => (n == null ? "—" : `${Number(n).toFixed(1)}s`);

function turnPairs(turns) {
    // Olha pares N→N+1 onde N tem answer e N+1 tem question.
    const pairs = [];
    for (let i = 0; i < turns.length - 1; i++) {
        const cur = turns[i];
        const nxt = turns[i + 1];
        if (!cur?.answered_at || !nxt?.asked_at) continue;
        const studentSpeak = Number(cur.answer_audio_duration_seconds ?? 0);
        const serverLatency = (new Date(nxt.asked_at) - new Date(cur.answered_at)) / 1000;
        const interviewerSpeak = Number(nxt.question_audio_duration_seconds ?? 0);
        pairs.push({
            turnFrom: cur.index ?? i,
            turnTo: nxt.index ?? (i + 1),
            studentSpeak,
            serverLatency,
            interviewerSpeak,
        });
    }
    return pairs;
}

function analyzeOne(row) {
    let conv;
    try { conv = JSON.parse(row.conversation_json); } catch { return null; }
    const turns = Array.isArray(conv.turns) ? conv.turns : [];
    const answeredTurns = turns.filter(t => t.answered_at);
    if (answeredTurns.length < 2) return null;

    const pairs = turnPairs(turns);
    if (pairs.length === 0) return null;

    const sum = pairs.reduce(
        (a, p) => ({
            studentSpeak: a.studentSpeak + (p.studentSpeak || 0),
            serverLatency: a.serverLatency + (p.serverLatency || 0),
            interviewerSpeak: a.interviewerSpeak + (p.interviewerSpeak || 0),
        }),
        { studentSpeak: 0, serverLatency: 0, interviewerSpeak: 0 }
    );

    const superTAResponseTotal = sum.serverLatency + sum.interviewerSpeak;
    const humanBaselineTotal = sum.studentSpeak + sum.interviewerSpeak;
    const speedFactor = superTAResponseTotal > 0 ? (humanBaselineTotal / superTAResponseTotal) : null;

    return {
        token: row.submission_token,
        label: row.student_label,
        work: row.work_name,
        turns: turns.length,
        answered: answeredTurns.length,
        pairs,
        sum,
        superTAResponseTotal,
        humanBaselineTotal,
        speedFactor,
    };
}

(async () => {
    // submissions em modo áudio com conversa registrada.
    const r = await pool.query(`
      SELECT s.submission_token, s.student_label, s.frozen_interaction_mode,
             s.conversation_json,
             w.name AS work_name
      FROM submissions s
      JOIN works w ON w.id = s.work_id
      WHERE s.frozen_interaction_mode = 'audio'
        AND s.conversation_json IS NOT NULL
      ORDER BY s.updated_at DESC
    `);
    if (r.rowCount === 0) {
        console.log("Sem entrevistas em modo áudio com conversa registrada.");
        await pool.end();
        return;
    }

    const results = r.rows.map(analyzeOne).filter(Boolean);
    if (results.length === 0) {
        console.log("Sem entrevistas em modo áudio com pelo menos 2 turnos respondidos.");
        await pool.end();
        return;
    }
    // ordena pelas mais longas (mais turnos respondidos).
    results.sort((a, b) => b.answered - a.answered);

    console.log(`\n${results.length} entrevista(s) em áudio com >=2 turnos respondidos. Mostrando as ${Math.min(5, results.length)} mais longas:\n`);

    for (const e of results.slice(0, 5)) {
        console.log("=".repeat(72));
        console.log(`Token: ${e.token} · Aluno: ${e.label ?? "—"} · Trabalho: ${e.work}`);
        console.log(`Turnos planejados: ${e.turns}  ·  respondidos: ${e.answered}  ·  pares analisados: ${e.pairs.length}`);
        console.log("");
        console.log("Turno   Aluno fala    Servidor proc.    Entrevistador fala");
        for (const p of e.pairs) {
            console.log(`  ${String(p.turnFrom).padStart(2)}→${String(p.turnTo).padEnd(2)}  ${fmt(p.studentSpeak)}s     ${fmt(p.serverLatency)}s          ${fmt(p.interviewerSpeak)}s`);
        }
        console.log("");
        console.log(`Totais:`);
        console.log(`  Aluno falou:           ${fmtS(e.sum.studentSpeak)}`);
        console.log(`  Servidor processou:    ${fmtS(e.sum.serverLatency)}`);
        console.log(`  Entrevistador falou:   ${fmtS(e.sum.interviewerSpeak)}`);
        console.log("");
        console.log(`  Tempo de resposta SuperTA  (proc + fala):  ${fmtS(e.superTAResponseTotal)}`);
        console.log(`  Baseline humano hipotético (escuta + fala): ${fmtS(e.humanBaselineTotal)}`);
        if (e.speedFactor != null) {
            console.log(`  → SuperTA é ${e.speedFactor.toFixed(2)}× mais rápido que o baseline humano`);
        }
        console.log("");
    }

    // resumão final.
    const totals = results.reduce(
        (a, e) => ({
            studentSpeak: a.studentSpeak + e.sum.studentSpeak,
            serverLatency: a.serverLatency + e.sum.serverLatency,
            interviewerSpeak: a.interviewerSpeak + e.sum.interviewerSpeak,
        }),
        { studentSpeak: 0, serverLatency: 0, interviewerSpeak: 0 }
    );
    const totalSuperTA = totals.serverLatency + totals.interviewerSpeak;
    const totalHuman = totals.studentSpeak + totals.interviewerSpeak;
    console.log("=".repeat(72));
    console.log(`Agregado de ${results.length} entrevista(s):`);
    console.log(`  Aluno (escuta humana):       ${fmtS(totals.studentSpeak)}`);
    console.log(`  Servidor (proc. SuperTA):    ${fmtS(totals.serverLatency)}`);
    console.log(`  Entrevistador (fala):        ${fmtS(totals.interviewerSpeak)}`);
    console.log(`  SuperTA proc+fala:           ${fmtS(totalSuperTA)}`);
    console.log(`  Humano escuta+fala:          ${fmtS(totalHuman)}`);
    if (totalSuperTA > 0) {
        console.log(`  → SuperTA agregado é ${(totalHuman / totalSuperTA).toFixed(2)}× mais rápido que humano hipotético`);
    }

    await pool.end();
})();

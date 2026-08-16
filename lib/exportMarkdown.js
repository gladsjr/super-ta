// Exportação das avaliações da ENTREVISTA em Markdown (issue #247).
//
// Reproduz, em texto, o conteúdo da tela individual do aluno
// (static/conversation.html) para TODOS os alunos de um trabalho, num arquivo
// só. Fica de fora o que não cabe em texto: o vídeo do proctoring e os áudios do
// aluno (os alertas e os TRECHOS do vídeo entram, que é a informação de revisão).
//
// A ordem das seções segue a da tela, para quem lê o arquivo reconhecer o que
// viu: cabeçalho → fiscalização → devolutiva → avaliação interna → conversa →
// encerramento → auxiliares (apresentação, puladas, pendentes, document map).

const DEFENSE_LABEL = {
    solid: "defesa sólida",
    partial: "defesa parcial",
    weak: "defesa frágil",
    inconclusive: "inconclusivo",
};

const ASSESSMENT_LABEL = {
    solid: "sólida",
    partial: "parcial",
    weak: "frágil",
    evasive: "evasiva",
    not_answered: "não respondeu",
    inconclusive: "inconclusiva",
};

const IV_LABEL = {
    scope_clarification: "Esclarecimento de escopo",
    off_topic_redirect: "Redirecionamento (off-topic)",
    meta: "Meta-pergunta (modal)",
    follow_up: "Pedido de complemento",
    audio_intelligibility: "Áudio ininteligível — pedido de repetição",
};

// Limiares de exibição dos indícios de vídeo: os MESMOS da lista do professor
// (static/professor.html#videoAlertsList). Ver issue #245 — hoje a lista e a tela
// individual divergem; aqui seguimos a lista, que é a mais sensível, para o
// arquivo não esconder o que o professor viu no painel.
function videoAlerts(report) {
    const f = report && report.flags;
    if (!f) return [];
    const out = [];
    const at = x => (Array.isArray(x?.at) ? x.at : []);
    if (f.absent && f.absent.pct >= 20) out.push({ label: `ausência (${f.absent.pct}% dos frames)`, at: at(f.absent) });
    if (f.multiple_people && f.multiple_people.pct >= 20) out.push({ label: `mais de uma pessoa (${f.multiple_people.pct}%)`, at: at(f.multiple_people) });
    if (f.phone && (f.phone.pct >= 5 || f.phone.count >= 10)) out.push({ label: `celular (${f.phone.pct}%, ${f.phone.count} frames)`, at: at(f.phone) });
    if (f.hands && f.hands.flag) out.push({ label: "mãos fora do quadro", at: at(f.hands) });
    if (f.framing && f.framing.flag) out.push({ label: "enquadramento fora do padrão", at: at(f.framing) });
    return out;
}

function mmss(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtTime(iso) {
    if (!iso) return "—";
    // Horário de São Paulo: o professor lê o arquivo no fuso dele, não em UTC.
    try {
        return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    } catch { return String(iso); }
}

// Texto livre dentro do .md: normaliza quebras e evita que uma linha começando
// com "#" ou "-" vire cabeçalho/lista por acidente.
function txt(s) {
    const v = String(s ?? "").trim();
    if (!v) return "";
    return v.replace(/\r\n/g, "\n").replace(/^([#>\-*])/gm, "\\$1");
}

function bullets(title, items) {
    const arr = Array.isArray(items) ? items.filter(x => x != null && String(x).trim() !== "") : [];
    if (!arr.length) return "";
    return `**${title}**\n\n${arr.map(x => `- ${txt(x)}`).join("\n")}\n\n`;
}

function block(title, body) {
    const v = txt(body);
    return v ? `**${title}**\n\n${v}\n\n` : "";
}

// ── Seções ────────────────────────────────────────────────────────────────

function secProctoring(report, videoParts) {
    if (!report && !videoParts) return "";
    let out = "### Fiscalização por vídeo\n\n";
    if (!report) {
        out += videoParts ? "_Vídeo gravado, análise ainda não concluída._\n\n" : "_Sem vídeo._\n\n";
        return out;
    }
    const alerts = videoAlerts(report);
    if (!alerts.length) {
        out += "Nenhum indício acima do limiar.\n\n";
    } else {
        out += "Indícios para revisão humana — **não** são acusação nem penalidade automática:\n\n";
        for (const a of alerts) {
            const trechos = a.at.length ? ` — trechos: ${a.at.map(mmss).join(", ")}` : "";
            out += `- ${a.label}${trechos}\n`;
        }
        out += "\n";
    }
    if (report.analyzed_at) out += `_Analisado em ${fmtTime(report.analyzed_at)}; ${report.frames ?? "?"} frames._\n\n`;
    return out;
}

function secStudentEvaluation(payload, personaName) {
    const ev = payload?.student_evaluation;
    if (!ev) return "";
    const pub = payload.published_at ? `publicada em ${fmtTime(payload.published_at)}` : "**não publicada**";
    let out = `### Devolutiva ao aluno\n\n_${pub}._\n\n`;
    if (ev.interviewer_opinion) {
        out += block(`Opinião do entrevistador${personaName ? ` (${personaName})` : ""}`, ev.interviewer_opinion);
    }
    out += block("Resumo", ev.summary);
    const pq = Array.isArray(ev.per_question) ? ev.per_question : [];
    if (pq.length) {
        out += "**Pergunta a pergunta**\n\n";
        for (const q of pq) {
            out += `- **Pergunta ${Number(q.turn_index) + 1}** — ${txt(q.question_gist)}\n  ${txt(q.feedback)}\n`;
        }
        out += "\n";
    }
    out += bullets("O que sustentou bem", ev.strengths);
    out += bullets("O que pode melhorar", ev.improvement_areas);
    out += bullets("Sugestões de estudo", ev.study_suggestions);
    return out;
}

function secInternalEvaluation(cached) {
    const ev = cached?.report;
    if (!ev) return "";
    const overall = ev.overall || {};
    let out = "### Avaliação interna (não vai ao aluno)\n\n";
    if (cached.evaluated_at) out += `_Gerada em ${fmtTime(cached.evaluated_at)}._\n\n`;
    if (overall.defense_quality) {
        out += `**Qualidade da defesa:** ${DEFENSE_LABEL[overall.defense_quality] ?? overall.defense_quality}\n\n`;
    }
    out += block("Resumo", overall.summary);
    out += block("Impressão do entrevistador", ev.interviewer_impression);
    const pq = Array.isArray(ev.per_question) ? ev.per_question : [];
    if (pq.length) {
        out += "**Pergunta a pergunta**\n\n";
        for (const q of pq) {
            const tag = ASSESSMENT_LABEL[q.answer_assessment] ?? q.answer_assessment ?? "—";
            out += `- **Turno ${Number(q.turn_index) + 1}** — ${txt(q.question_gist)} _(${tag})_\n`;
            if (q.comment) out += `  ${txt(q.comment)}\n`;
            if (q.evidence) out += `  Evidência: ${txt(q.evidence)}\n`;
        }
        out += "\n";
    }
    out += bullets("Pontos fortes da defesa", ev.strengths);
    out += bullets("Pontos fracos da defesa", ev.weaknesses);
    out += bullets("Sugestões de follow-up presencial", ev.follow_up_suggestions);
    out += bullets("Ressalvas desta avaliação", ev.caveats);
    return out;
}

function secInterventions(list) {
    if (!Array.isArray(list) || !list.length) return "";
    let out = "*Intervenções antes da resposta final:*\n\n";
    list.forEach((iv, i) => {
        const type = String(iv.type ?? "");
        out += `- **Intervenção ${i + 1} — ${IV_LABEL[type] ?? type}**`;
        if (iv.follow_up_reason) out += ` (${iv.follow_up_reason})`;
        out += `\n  - aluno: ${txt(iv.student_message) || "—"}\n  - agente: ${txt(iv.assistant_response) || "—"}\n`;
        if (iv.reason) out += `  - motivo: ${txt(iv.reason)}\n`;
    });
    return out + "\n";
}

function secConversation(conv) {
    const turns = Array.isArray(conv?.turns) ? conv.turns : [];
    if (!turns.length) return "";
    let out = "### Conversa\n\n";
    for (const t of turns) {
        const m = t.question_metadata || {};
        out += `#### Turno ${t.index + 1}${m.id != null ? ` · plan id ${m.id}` : ""}\n\n`;
        out += `_${fmtTime(t.asked_at)}${t.answered_at ? ` → ${fmtTime(t.answered_at)}` : ""}_\n\n`;
        out += block("Pergunta", t.question);
        out += block("Justificativa", t.rationale);
        out += secInterventions(t.interventions);
        out += block("Resposta do aluno", t.answer || "_(sem resposta)_");
        if (t.transition_to_next) out += `→ Transição: "${txt(t.transition_to_next)}"\n\n`;
    }
    return out;
}

function secClosing(conv) {
    const fin = conv?.finalization;
    if (!fin) return "";
    let out = "### Encerramento\n\n";
    out += `- Motivo: ${txt(fin.completion_reason) || "—"}\n`;
    out += `- Encerrada em: ${fmtTime(fin.completed_at)}\n\n`;
    out += block("Despedida do entrevistador", fin.message);
    out += block("Comentário do aluno", fin.student_comment);
    return out;
}

function secAux(conv) {
    let out = "";
    const intro = Array.isArray(conv?.intro?.messages) ? conv.intro.messages : [];
    if (intro.length) {
        out += "### Apresentação\n\n";
        // Mesmos campos da tela (conversation.html:1211-1216): role + content.
        for (const m of intro) out += `- **${m.role === "assistant" ? "agente" : "aluno"}**: ${txt(m.content)}\n`;
        if (conv.intro.transitioned_at) out += `\n_Transição para a entrevista: ${fmtTime(conv.intro.transitioned_at)}_\n`;
        out += "\n";
    }
    const skipped = Array.isArray(conv?.skipped_questions) ? conv.skipped_questions : [];
    if (skipped.length) {
        out += "### Perguntas puladas\n\n";
        for (const s of skipped) out += `- ${txt(s.question)} — motivo: ${txt(s.reason) || "—"}\n`;
        out += "\n";
    }
    const pending = Array.isArray(conv?.pending_questions) ? conv.pending_questions : [];
    if (pending.length) {
        out += "### Perguntas planejadas não feitas\n\n";
        for (const p of pending) out += `- ${txt(p.question)}\n`;
        out += "\n";
    }
    if (conv?.document_map) {
        out += "### Document map\n\n```json\n" + JSON.stringify(conv.document_map, null, 2) + "\n```\n\n";
    }
    return out;
}

// ── Montagem ──────────────────────────────────────────────────────────────

/**
 * Markdown de UM aluno. `data` traz o que a tela individual carrega:
 * { submission, conversation, evaluation, studentEvaluation, proctorReport,
 *   videoParts, personaName }
 */
export function submissionMarkdown(data) {
    const s = data.submission || {};
    let out = `## ${txt(s.student_label) || "(sem rótulo)"}\n\n`;
    out += `- Status: ${txt(s.status) || "—"}\n`;
    out += `- Token: \`${txt(s.submission_token)}\`\n`;
    if (s.is_test) out += `- **Envio de teste**\n`;
    out += "\n";
    out += secProctoring(data.proctorReport, data.videoParts);
    out += secStudentEvaluation(data.studentEvaluation, data.personaName);
    out += secInternalEvaluation(data.evaluation);
    out += secConversation(data.conversation);
    out += secClosing(data.conversation);
    out += secAux(data.conversation);
    return out.trimEnd() + "\n";
}

/** Documento completo: cabeçalho do trabalho + um bloco por aluno. */
export function workMarkdown({ workName, generatedAt, submissions }) {
    let out = `# Avaliações — ${txt(workName) || "(trabalho sem nome)"}\n\n`;
    out += `_Exportado em ${fmtTime(generatedAt)} · ${submissions.length} aluno(s)._\n\n`;
    out += "> Documento interno do professor: contém a avaliação interna e os indícios de\n";
    out += "> fiscalização, que **não** vão ao aluno. Os indícios são para revisão humana —\n";
    out += "> nunca acusação nem penalidade automática.\n\n---\n\n";
    out += submissions.map(submissionMarkdown).join("\n---\n\n");
    return out;
}

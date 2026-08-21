// Retomada de sessão de voz exige liberação do professor (issue #260).
//
// Fonte ÚNICA da decisão, usada pelos dois fluxos de voz (prova oral em
// lib/oralRealtime.js e entrevista realtime em lib/liveInterview.js) e pelas
// rotas de status que informam a página do aluno.
//
// O que conta como RETOMADA: aluno REAL, sessão anterior com fala do aluno.
// É o mesmo critério que os adapters já usavam para decidir `resuming` — se a
// queda foi durante a apresentação (só falas do examinador), recomeça normal,
// sem liberação, porque não há gravação anterior com conteúdo a proteger.
//
// Por que bloquear: retomada automática produzia vídeo fragmentado e silencioso
// (nova parte por queda, caso 222b9f5ef8d6 com 7 partes). Com a ADR 0005 o
// vídeo é bloqueante; deixar a sessão renascer sozinha era falhar em aberto.
// A liberação é CONSUMIDA na conexão (volta a NULL): cada nova queda exige
// novo aval do professor.

// A sessão que está para abrir seria uma retomada?
//
// speechEvents (#283): contador de EVENTOS de fala do aluno que o relay grava
// em oral_voice_json.student_speech_events — independe de a transcrição ter
// virado texto. Cobre a sessão em que o aluno FALOU mas o STT só produziu
// lixo/vazio (o texto de aluno some do transcript e o gate erraria "não é
// retomada"). Sessões antigas, sem o contador, seguem decidindo pelo texto.
export function wouldResume({ isTest, priorTranscript, speechEvents = 0 }) {
    if (isTest) return false; // teste sempre recomeça do zero (comportamento antigo)
    if (Number(speechEvents) > 0) return true;
    return Array.isArray(priorTranscript) && priorTranscript.some(t => t?.role === "student");
}

// Código de erro que o upgrade devolve e a página do aluno entende.
export const RESUME_BLOCKED = "resume_blocked";

// Conta as falas do aluno na transcrição parcial — é o "em que ponto parou"
// que o professor vê antes de decidir liberar.
export function studentTurnCount(priorTranscript) {
    if (!Array.isArray(priorTranscript)) return 0;
    return priorTranscript.filter(t => t?.role === "student").length;
}

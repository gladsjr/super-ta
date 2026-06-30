// Data access layer for SuperTA. All filesystem-backed storage of works,
// submissions, interviewer templates and the conversation log lives here.
// Callers (server.js, lib/conversationLog.js, lib/middleware.js) speak in
// terms of these helpers and never touch SQL directly.
//
// Este arquivo é apenas o BARREL: após o split por domínio, as queries vivem em
// lib/db/<dominio>.js e são re-exportadas aqui. Importar `* as db from
// "../lib/db.js"` continua funcionando igual, com todas as exports acessíveis.
// Sem mudança de comportamento — só reorganização. Helpers internos não
// exportados (newToken, STATUS_EXPR) ficam em lib/db/_shared.js.

export * from "./db/works.js";
export * from "./db/submissions.js";
export * from "./db/oral.js";
export * from "./db/templates.js";
export * from "./db/audio.js";

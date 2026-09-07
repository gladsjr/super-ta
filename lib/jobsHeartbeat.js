// Batimento do executor de jobs (#375). Módulo minúsculo e sem dependências,
// de propósito: o jobRunner escreve aqui a cada tique e o health check lê —
// sem o health importar o jobRunner (que puxa relay, retranscrição e fila de
// vídeo). "Executor parado" é a pergunta que a profundidade da fila não
// responde: a fila pode estar vazia porque nada entrou, ou porque parou.
export const heartbeat = {
    started_at: null,   // Date — startJobRunner foi chamado
    last_tick_at: null, // Date — início do último tique
    last_error: null,   // string — erro do último tique, se houve
};

export function markStarted() { heartbeat.started_at = new Date(); }
export function markTick() { heartbeat.last_tick_at = new Date(); heartbeat.last_error = null; }
export function markTickError(msg) { heartbeat.last_error = String(msg || ""); }

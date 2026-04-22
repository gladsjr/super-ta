/**
 * Minimal leveled logger for SuperTA.
 *
 * Levels (low → high verbosity): error, warn, info, debug, trace
 * Controlled by env var LOG_LEVEL (default: info).
 *
 * Line format: HH:MM:SS LEVEL [SCOPE] message { ...meta }
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

const configured = (process.env.LOG_LEVEL || "info").toLowerCase();
const currentLevel = LEVELS[configured] ?? LEVELS.info;

function ts() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtMeta(meta) {
    if (!meta || (typeof meta === "object" && Object.keys(meta).length === 0)) return "";
    try {
        return " " + JSON.stringify(meta);
    } catch {
        return "";
    }
}

function emit(level, scope, msg, meta) {
    if (LEVELS[level] > currentLevel) return;
    const label = level.toUpperCase().padEnd(5, " ");
    const scopeTag = scope ? ` [${scope}]` : "";
    const line = `${ts()} ${label}${scopeTag} ${msg}${fmtMeta(meta)}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
}

function enabled(level) {
    return LEVELS[level] <= currentLevel;
}

export function preview(text, max = 160) {
    if (text == null) return "";
    const s = String(text).replace(/\s+/g, " ").trim();
    if (s.length <= max) return `"${s}"`;
    return `"${s.slice(0, max)}…" (+${s.length - max} chars)`;
}

/**
 * Log a prompt: short preview at INFO, full body at DEBUG.
 * Intended to be called right before an openai.responses.create() call.
 */
export function prompt(scope, promptText) {
    const len = promptText ? String(promptText).length : 0;
    emit("info", scope, `prompt (${len} chars) ${preview(promptText, 120)}`);
    if (enabled("debug")) {
        emit("debug", scope, `prompt.full:\n${promptText}`);
    }
}

/**
 * Wrap an async operation with start/ok/fail logs + duration.
 * Returns whatever `fn` returns. Re-throws on failure.
 */
export async function span(scope, label, fn) {
    emit("info", scope, `${label} start`);
    const started = Date.now();
    try {
        const result = await fn();
        const dur = ((Date.now() - started) / 1000).toFixed(1);
        emit("info", scope, `${label} ok (${dur}s)`);
        return result;
    } catch (err) {
        const dur = ((Date.now() - started) / 1000).toFixed(1);
        emit("error", scope, `${label} fail (${dur}s): ${err.message}`);
        if (enabled("debug") && err.stack) emit("debug", scope, err.stack);
        throw err;
    }
}

export const log = {
    error: (scope, msg, meta) => emit("error", scope, msg, meta),
    warn:  (scope, msg, meta) => emit("warn",  scope, msg, meta),
    info:  (scope, msg, meta) => emit("info",  scope, msg, meta),
    debug: (scope, msg, meta) => emit("debug", scope, msg, meta),
    trace: (scope, msg, meta) => emit("trace", scope, msg, meta),
    prompt,
    preview,
    span,
    enabled,
    level: configured,
};

export default log;

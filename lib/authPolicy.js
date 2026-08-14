// Política de senha e rate limit REFORÇADOS (issue #157) — ligados SÓ quando o
// ambiente pede: ENFORCE_AUTH_POLICY=true. Default OFF, para não endurecer
// ambientes (dev/piloto) que não configuraram — como o usuário pediu ("só em
// ambientes com configuração para reforçar essas políticas").
export const AUTH_POLICY_STRICT = process.env.ENFORCE_AUTH_POLICY === "true";

// Mínimo de senha: 6 (brando, default) ou 8 (reforçado).
export const MIN_PASSWORD_LEN = AUTH_POLICY_STRICT ? 8 : 6;

// Valida a força da senha conforme a política vigente. LANÇA (status 400) se
// fraca. NIST favorece COMPRIMENTO sobre composição — no modo reforçado exigimos
// 8+ e barramos só os padrões mais triviais (um caractere repetido; só dígitos).
export function assertPasswordOk(password) {
    const p = String(password ?? "");
    if (p.length < MIN_PASSWORD_LEN) {
        throw Object.assign(new Error(AUTH_POLICY_STRICT ? "password_too_weak" : "password_too_short"), { status: 400 });
    }
    if (AUTH_POLICY_STRICT) {
        if (/^(.)\1+$/.test(p)) throw Object.assign(new Error("password_too_weak"), { status: 400 });
        if (/^\d+$/.test(p)) throw Object.assign(new Error("password_too_weak"), { status: 400 });
    }
}

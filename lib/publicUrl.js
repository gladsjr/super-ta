// Origem pública canônica dos links que compartilhamos com humanos (link do aluno,
// link de ativação de convite). É deliberadamente um FALLBACK, não uma hierarquia
// obscura:
//
//   - Em produção, a env var PUBLIC_BASE_URL fixa o domínio oficial
//     (ex.: https://oratia.education). Assim o link sai canônico
//     INDEPENDENTEMENTE de por qual host o professor acessou (super-ta.replit.app,
//     domínio de instituição, etc.).
//   - Sem a env var — dev local, túnel cloudflared, preview do Replit — cai no host
//     da própria requisição. Continua funcionando em qualquer endereço, que é o
//     ponto: o link aberto tem de bater no MESMO servidor que o gerou.
//
// NÃO use isto para o redirect_uri do OAuth (que precisa casar exatamente com o
// registrado no provedor) nem para WebSockets do aluno (que devem apontar para o
// host onde o aluno está). Isto é só para links que uma pessoa vai abrir depois.
export function publicBaseUrl(req) {
    const configured = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    const xfProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
    const proto = xfProto || req.protocol || "http";
    const host = req.get("x-forwarded-host") || req.get("host");
    return `${proto}://${host}`;
}

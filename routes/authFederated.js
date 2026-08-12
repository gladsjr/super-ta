// Login federado (SSO). v1: Google (OIDC). Microsoft/Apple depois, pelo mesmo
// padrão. Implementação SEM dependência nova: usa os endpoints OIDC do Google
// via fetch (Node 18+). Se as credenciais não estiverem configuradas, responde
// 501 — o boot nunca quebra por isto.
//
// Config por env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, [GOOGLE_REDIRECT_URI].
// Coexiste com login local e com o acesso por token (não toca nenhum dos dois).

import express from "express";
import crypto from "crypto";
import { provisionFederatedUser } from "../auth.js";
import log from "../lib/logger.js";

const router = express.Router();

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

function googleConfig(req) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI
        || `${req.protocol}://${req.get("host")}/auth/google/callback`;
    return { clientId, clientSecret, redirectUri };
}

// Início: redireciona ao consentimento do Google com um `state` anti-CSRF.
router.get("/auth/google", (req, res) => {
    const cfg = googleConfig(req);
    if (!cfg) return res.status(501).json({ error: "google_sso_not_configured", detail: "Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET." });
    const state = crypto.randomBytes(16).toString("hex");
    req.session.oauthState = state;
    const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        prompt: "select_account",
    });
    res.redirect(`${AUTH_URL}?${params.toString()}`);
});

// Callback: valida state, troca code por tokens, lê o perfil, provisiona/associa
// o usuário (user_identities, provedor 'google') e abre sessão (mesma
// regeneração do login local — anti session-fixation).
router.get("/auth/google/callback", async (req, res) => {
    const cfg = googleConfig(req);
    if (!cfg) return res.status(501).json({ error: "google_sso_not_configured" });
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) {
        return res.status(400).json({ error: "invalid_oauth_state" });
    }
    delete req.session.oauthState;
    try {
        const tokenResp = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                code: String(code),
                client_id: cfg.clientId,
                client_secret: cfg.clientSecret,
                redirect_uri: cfg.redirectUri,
                grant_type: "authorization_code",
            }).toString(),
        });
        if (!tokenResp.ok) throw new Error(`token exchange ${tokenResp.status}`);
        const tokens = await tokenResp.json();

        const uiResp = await fetch(USERINFO_URL, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (!uiResp.ok) throw new Error(`userinfo ${uiResp.status}`);
        const info = await uiResp.json(); // { sub, email, email_verified, name, ... }
        if (!info.sub) throw new Error("userinfo sem sub");

        const user = await provisionFederatedUser({
            provider: "google",
            sub: info.sub,
            // Só casa por e-mail se verificado; senão vincula só por sub.
            email: info.email_verified === false ? null : (info.email || null),
            displayName: info.name || null,
        });

        req.session.regenerate((err) => {
            if (err) { log.error("AUTH", `regenerate failed: ${err.message}`); return res.status(500).json({ error: "login failed" }); }
            req.session.user = { id: user.id, username: user.username, email: user.email || null };
            req.session.authProvider = { key: "google", kind: "google" }; // realm aberto
            req.session.save((e2) => {
                if (e2) { log.error("AUTH", `session save failed: ${e2.message}`); return res.status(500).json({ error: "login failed" }); }
                log.info("AUTH", `google login user=${user.username} id=${user.id}`);
                res.redirect("/");
            });
        });
    } catch (err) {
        log.error("AUTH", `google callback failed: ${err.message}`);
        res.status(502).json({ error: "google_login_failed" });
    }
});

export default router;

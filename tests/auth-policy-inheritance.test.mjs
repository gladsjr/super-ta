// Testes da HERANÇA de política de provedor (issue #160): a política SSO-only de
// uma unidade-raiz protege toda a sua sub-árvore; filhas sem política própria
// herdam do ancestral mais próximo; uma política própria numa filha é o override
// (inclusive para reabrir). Sem nenhum ancestral com política → realm aberto.
// Rodar: node --test -r dotenv/config tests/auth-policy-inheritance.test.mjs
//        (dotenv só porque lib/tenants.js importa o pool; unitAcceptsProvider é pura)

import { test } from "node:test";
import assert from "node:assert/strict";
import { unitAcceptsProvider } from "../lib/tenants.js";

// Árvore: raiz FGV(8) SSO-only; filhas 11 e 12; neto 20 sob 11. Unidade 99 = árvore
// sem nenhuma política (realm aberto).
const parent = new Map([[8, null], [11, 8], [12, 8], [20, 11], [99, null]]);
const base = { policy: new Map([[8, new Set(["mock_sso_fgv_8"])]]), parent };

test("filha sem política herda SSO-only da raiz: login local é barrado", () => {
    assert.equal(unitAcceptsProvider(base, 11, "local", "local"), false);
});

test("filha aceita o SSO herdado da raiz", () => {
    assert.equal(unitAcceptsProvider(base, 11, "mock_sso_fgv_8", "mock"), true);
});

test("herança atravessa mais de dois níveis (neto)", () => {
    assert.equal(unitAcceptsProvider(base, 20, "local", "local"), false);
});

test("a própria raiz aplica sua política", () => {
    assert.equal(unitAcceptsProvider(base, 8, "local", "local"), false);
});

test("override: política PRÓPRIA na filha reabre o login local", () => {
    const over = { policy: new Map([[8, new Set(["mock_sso_fgv_8"])], [12, new Set(["local"])]]), parent };
    assert.equal(unitAcceptsProvider(over, 12, "local", "local"), true);
    // o override é local à 12 — a 11 segue herdando SSO-only
    assert.equal(unitAcceptsProvider(over, 11, "local", "local"), false);
});

test("árvore sem política: realm aberto (local/google) preservado", () => {
    assert.equal(unitAcceptsProvider(base, 99, "local", "local"), true);
    assert.equal(unitAcceptsProvider(base, 99, "g", "google"), true);
    assert.equal(unitAcceptsProvider(base, 99, "x", "oidc"), false);
});

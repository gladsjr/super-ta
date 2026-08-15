// Testes das travas de pacote (issue #152): TODA trava declarada na DSL tem um
// consumidor no runtime; chave desconhecida FALHA na carga do template; os
// pacotes atualmente vendidos (config/packages/*.yaml) validam e expandem com as
// travas preservadas. `max_follow_ups` é o teto TOTAL de follow-ups por pergunta
// aplicado no dispatcher do /chat (routes/interview.js) — aqui garantimos que ele
// chega íntegro do YAML ao spec expandido.
// Rodar: node --test -r dotenv/config tests/packages-locks.test.mjs
//        (dotenv só porque lib/packages.js importa o pool via auth.js; validateAndExpand é pura)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { validateAndExpand } from "../lib/packages.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.join(HERE, "..", "config", "packages");

// Base mínima válida — cada caso muta só a trava sob teste.
function docWith(locks) {
    return {
        key: "teste",
        version: 1,
        name: "Pacote de teste",
        items: [{ key: "prof", kind: "interview", variant: "messages", quantity: 1, locks }],
    };
}

test("pacotes vendidos validam e expandem sem erro", () => {
    const files = fs.readdirSync(PACKAGES_DIR).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    assert.ok(files.length >= 1, "deve haver ao menos um pacote em config/packages");
    for (const f of files) {
        const doc = yaml.load(fs.readFileSync(path.join(PACKAGES_DIR, f), "utf8"));
        assert.doesNotThrow(() => validateAndExpand(doc, f), `pacote ${f} deveria validar`);
    }
});

test("os locks dos pacotes vendidos só usam chaves com consumidor", () => {
    const KNOWN = new Set(["question_count", "interaction_mode", "max_follow_ups", "evaluation_mode", "grade"]);
    const files = fs.readdirSync(PACKAGES_DIR).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    for (const f of files) {
        const doc = yaml.load(fs.readFileSync(path.join(PACKAGES_DIR, f), "utf8"));
        for (const item of doc.items ?? []) {
            for (const k of Object.keys(item.locks ?? {})) {
                assert.ok(KNOWN.has(k), `pacote ${f} item "${item.key}" usa trava sem consumidor: "${k}"`);
            }
        }
    }
});

test("chave de trava desconhecida FALHA na carga (fail-closed)", () => {
    assert.throws(
        () => validateAndExpand(docWith({ max_followups: 1 })), // typo clássico: sem o "_"
        /trava desconhecida "max_followups"/,
    );
    assert.throws(
        () => validateAndExpand(docWith({ inventada: true })),
        /trava desconhecida "inventada"/,
    );
});

test("max_follow_ups: aceita inteiro >= 0 e chega íntegro ao spec", () => {
    for (const n of [0, 1, 3]) {
        const spec = validateAndExpand(docWith({ max_follow_ups: n }));
        assert.equal(spec.items[0].locks.max_follow_ups, n);
        assert.equal(spec.counters[0].locks_json.max_follow_ups, n);
    }
});

test("max_follow_ups inválido (negativo / não-inteiro) falha", () => {
    assert.throws(() => validateAndExpand(docWith({ max_follow_ups: -1 })), /max_follow_ups/);
    assert.throws(() => validateAndExpand(docWith({ max_follow_ups: 1.5 })), /max_follow_ups/);
    assert.throws(() => validateAndExpand(docWith({ max_follow_ups: "2" })), /max_follow_ups/);
});

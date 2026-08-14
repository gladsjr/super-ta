// Pacotes (Portão B do controle de uso). A "linguagem" de pacotes vive em
// config/packages/*.yaml (fonte da verdade), é validada+expandida aqui e
// sincronizada no banco por seedPackageTemplates() (auth.js).
//
// Modelo (ver docs/access-model.md):
// - Distribuição/delegação em PACOTES INTEIROS (package_allocations.granted/
//   delegated_packages), em cascata manual pela árvore de unidades.
// - Consumo ITEM A ITEM: cada item do template vira um contador
//   (entitlement_counters). Capacidade(item) = (granted − delegated) ×
//   item_quantity; disponível = capacidade − consumed_qty. Pool da unidade —
//   não vinculado a aluno.
//
// Config pura: NUNCA vai ao LLM. Fail-fast no boot se um YAML for inválido.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { pool } from "../auth.js";
import { MIN_QUESTION_COUNT, MAX_QUESTION_COUNT } from "./config.js";
import { descendantUnitIds } from "./units.js";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.resolve(LIB_DIR, "..", "config", "packages");

const KIND_SET = new Set(["interview", "oral_realtime", "scenario"]);
const MODE_SET = new Set(["text", "audio"]);
const KEY_RE = /^[a-z0-9_]+$/;

// Registry em memória: key -> spec expandido. Preenchido por loadPackageTemplates().
const SPECS = new Map();

export function getPackageSpec(key) {
    return SPECS.get(key) || null;
}
export function listPackageSpecs() {
    return [...SPECS.values()];
}

// ---------------------------------------------------------------------------
// Validação + expansão do DSL
// ---------------------------------------------------------------------------

function fail(msg) {
    throw new Error(`config/packages: ${msg}`);
}

function validateLocks(itemKey, locks) {
    if (locks == null) return {};
    if (typeof locks !== "object" || Array.isArray(locks)) fail(`item "${itemKey}" locks deve ser objeto`);
    const out = {};
    if ("question_count" in locks) {
        const q = locks.question_count;
        if (!Number.isInteger(q) || q < MIN_QUESTION_COUNT || q > MAX_QUESTION_COUNT) {
            fail(`item "${itemKey}" question_count fora de [${MIN_QUESTION_COUNT},${MAX_QUESTION_COUNT}]: ${q}`);
        }
        out.question_count = q;
    }
    if ("interaction_mode" in locks) {
        if (!MODE_SET.has(locks.interaction_mode)) fail(`item "${itemKey}" interaction_mode inválido: ${locks.interaction_mode}`);
        out.interaction_mode = locks.interaction_mode;
    }
    if ("max_follow_ups" in locks) {
        const m = locks.max_follow_ups;
        if (!Number.isInteger(m) || m < 0) fail(`item "${itemKey}" max_follow_ups deve ser inteiro >= 0: ${m}`);
        out.max_follow_ups = m;
    }
    if ("evaluation_mode" in locks) {
        if (!["full", "automatic_only"].includes(locks.evaluation_mode)) {
            fail(`item "${itemKey}" evaluation_mode inválido: ${locks.evaluation_mode}`);
        }
        out.evaluation_mode = locks.evaluation_mode;
    }
    if ("grade" in locks) out.grade = locks.grade === true;
    return out;
}

// Recebe o doc YAML já parseado. Devolve o spec expandido:
// { key, version, name, items:[...], counters:[{item_key,item_quantity,locks_json}] }
export function validateAndExpand(doc, filename = "?") {
    if (!doc || typeof doc !== "object") fail(`${filename}: YAML vazio/inválido`);
    if (!KEY_RE.test(String(doc.key || ""))) fail(`${filename}: key inválida (use [a-z0-9_]): "${doc.key}"`);
    if (!Number.isInteger(doc.version) || doc.version < 1) fail(`${filename}: version deve ser inteiro >= 1`);
    if (!doc.name || typeof doc.name !== "string") fail(`${filename}: name obrigatório`);
    if (!Array.isArray(doc.items) || doc.items.length === 0) fail(`${filename}: items deve ser lista não-vazia`);

    const items = [];
    const counters = [];
    const seen = new Set();

    for (const raw of doc.items) {
        const key = String(raw?.key || "");
        if (!KEY_RE.test(key)) fail(`${filename}: item key inválida: "${key}"`);
        if (seen.has(key)) fail(`${filename}: item key duplicada: "${key}"`);
        seen.add(key);
        if (!KIND_SET.has(raw.kind)) fail(`${filename}: item "${key}" kind inválido: ${raw.kind}`);
        const quantity = raw.quantity;
        if (!Number.isInteger(quantity) || quantity < 1) fail(`${filename}: item "${key}" quantity deve ser inteiro >= 1`);
        const locks = validateLocks(key, raw.locks);
        // Variante só existe (e é obrigatória) para interview: é ela que separa
        // a entrevista simplificada (realtime) da profunda (messages). Fail-fast
        // no boot — um typo aqui venderia o produto errado.
        const variant = raw.variant ? String(raw.variant) : null;
        if (raw.kind === "interview") {
            if (variant !== "messages" && variant !== "realtime") {
                fail(`${filename}: item "${key}" (interview) exige variant "messages" ou "realtime"; veio: ${raw.variant ?? "(ausente)"}`);
            }
        } else if (variant != null) {
            fail(`${filename}: item "${key}" (${raw.kind}) não aceita variant`);
        }

        // prep: caps por PACOTE. >= 1 vira contador derivado; 0 vira flag no lock.
        const prep = {};
        if (raw.prep != null) {
            if (typeof raw.prep !== "object" || Array.isArray(raw.prep)) fail(`${filename}: item "${key}" prep deve ser objeto`);
            for (const [pk, pv] of Object.entries(raw.prep)) {
                if (!Number.isInteger(pv) || pv < 0) fail(`${filename}: item "${key}" prep.${pk} deve ser inteiro >= 0`);
                prep[pk] = pv;
            }
        }

        items.push({ key, kind: raw.kind, variant, quantity, locks, prep });

        // Contador principal do item.
        counters.push({ item_key: key, item_quantity: quantity, locks_json: locks });

        // Contadores de prep (só caps >= 1; o item_quantity do contador é o cap
        // por pacote). assistant_interactions: 0 NÃO vira contador — vira o lock
        // allow_assistant=false no contador principal (enforcement em routes/work.js).
        for (const [pk, pv] of Object.entries(prep)) {
            if (pk === "assistant_interactions" && pv === 0) {
                counters[counters.length - 1].locks_json = { ...locks, allow_assistant: false };
                continue;
            }
            if (pv >= 1) {
                counters.push({ item_key: `${key}__prep_${pk}`, item_quantity: pv, locks_json: {} });
            }
        }
    }

    return { key: doc.key, version: doc.version, name: doc.name, items, counters };
}

// Lê config/packages/*.yaml, valida+expande, popula o registry em memória e
// devolve [{ key, version, name, yamlText, spec }]. Fail-fast se algo inválido.
export function loadPackageTemplates() {
    if (!fs.existsSync(PACKAGES_DIR)) {
        throw new Error(`config/packages/ não encontrado em ${PACKAGES_DIR}`);
    }
    const files = fs.readdirSync(PACKAGES_DIR).filter((f) => /\.ya?ml$/i.test(f)).sort();
    const out = [];
    SPECS.clear();
    for (const filename of files) {
        const yamlText = fs.readFileSync(path.join(PACKAGES_DIR, filename), "utf8");
        const doc = yaml.load(yamlText);
        const spec = validateAndExpand(doc, filename);
        if (SPECS.has(spec.key)) fail(`key duplicada entre arquivos: "${spec.key}"`);
        SPECS.set(spec.key, spec);
        out.push({ key: spec.key, version: spec.version, name: spec.name, yamlText, spec });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Alocação + cascata
// ---------------------------------------------------------------------------

// Cria uma allocation + seus contadores (a partir do spec) dentro de um client
// de transação já aberto.
async function insertAllocationWithCounters(client, { templateKey, version, unitId, parentAllocationId, grantedPackages, grantedByUserId, source, spec }) {
    const a = await client.query(
        `INSERT INTO package_allocations
           (template_key, template_version, unit_id, parent_allocation_id, granted_packages, granted_by_user_id, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [templateKey, version, unitId, parentAllocationId, grantedPackages, grantedByUserId, source]
    );
    const allocationId = a.rows[0].id;
    for (const c of spec.counters) {
        await client.query(
            `INSERT INTO entitlement_counters (allocation_id, item_key, item_quantity, locks_json)
             VALUES ($1,$2,$3,$4)`,
            [allocationId, c.item_key, c.item_quantity, JSON.stringify(c.locks_json)]
        );
    }
    return allocationId;
}

// Trava de SOBREPOSIÇÃO DE TIPOS — só na TURMA (onde os pacotes são efetivamente
// consumidos). Uma turma não pode receber dois pacotes cujos TIPOS (itens
// principais: prova_oral / entrevista_*) se cruzem: senão o vínculo trabalho→
// contador vira ambíguo E a economia não fecha (pacotes podem embutir subsídio/
// desconto, então itens de pacotes distintos NÃO se somam complementarmente).
// Nós intermediários da árvore PODEM sobrepor (só distribuem, não consomem).
// Ver docs/access-model.md + memória "pacotes-subsídio-sem-sobreposição".
async function assertNoTypeOverlapOnClass(client, unitId, newTemplateKey) {
    const u = await client.query(`SELECT is_class FROM units WHERE id = $1`, [unitId]);
    if (!u.rows[0]?.is_class) return; // só turma
    const spec = SPECS.get(newTemplateKey);
    const newTypes = new Set((spec?.items || []).map((i) => i.key));
    if (newTypes.size === 0) return;
    const existing = await client.query(
        `SELECT DISTINCT template_key FROM package_allocations WHERE unit_id = $1 AND template_key <> $2`,
        [unitId, newTemplateKey]
    );
    for (const row of existing.rows) {
        for (const it of (SPECS.get(row.template_key)?.items || [])) {
            if (newTypes.has(it.key)) {
                throw Object.assign(new Error("type_overlap_on_class"), { status: 409, itemKey: it.key, otherTemplate: row.template_key });
            }
        }
    }
}

// Concessão RAIZ: cria N pacotes de um template numa unidade (sem pai).
export async function allocateRoot({ templateKey, unitId, packages, grantedByUserId = null, source = "manual" }) {
    const spec = SPECS.get(templateKey);
    if (!spec) throw Object.assign(new Error("unknown_template"), { status: 400 });
    const n = Number(packages);
    if (!Number.isInteger(n) || n < 0) throw Object.assign(new Error("invalid_packages"), { status: 400 });
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await assertNoTypeOverlapOnClass(client, unitId, templateKey);
        const id = await insertAllocationWithCounters(client, {
            templateKey, version: spec.version, unitId, parentAllocationId: null,
            grantedPackages: n, grantedByUserId, source, spec,
        });
        await client.query("COMMIT");
        return { allocationId: id };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// DELEGA `packages` pacotes de uma allocation-pai para uma unidade filha.
// Atômico: só delega o que está disponível (granted − delegated − comprometido
// pelo consumo local). "Comprometido" = máx sobre os contadores de
// ceil(consumed_qty / item_quantity) — pacotes que não podem descer porque já
// foram tocados localmente.
export async function allocateToChild({ parentAllocationId, childUnitId, packages, grantedByUserId = null, source = "manual" }) {
    const n = Number(packages);
    if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("invalid_packages"), { status: 400 });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const parent = await client.query(
            `SELECT id, template_key, template_version, unit_id FROM package_allocations WHERE id = $1 FOR UPDATE`,
            [parentAllocationId]
        );
        if (parent.rowCount === 0) throw Object.assign(new Error("parent_not_found"), { status: 404 });
        const spec = SPECS.get(parent.rows[0].template_key);
        if (!spec) throw Object.assign(new Error("unknown_template"), { status: 400 });
        await assertNoTypeOverlapOnClass(client, childUnitId, parent.rows[0].template_key);

        const upd = await client.query(
            `WITH committed AS (
                 SELECT COALESCE(MAX(CEIL(consumed_qty::numeric / item_quantity)), 0) AS c
                   FROM entitlement_counters WHERE allocation_id = $1
             )
             UPDATE package_allocations pa
                SET delegated_packages = delegated_packages + $2
               FROM committed
              WHERE pa.id = $1
                AND (pa.granted_packages - pa.delegated_packages - committed.c) >= $2
             RETURNING pa.id`,
            [parentAllocationId, n]
        );
        if (upd.rowCount === 0) throw Object.assign(new Error("insufficient_packages"), { status: 409 });

        const childId = await insertAllocationWithCounters(client, {
            templateKey: parent.rows[0].template_key,
            version: parent.rows[0].template_version,
            unitId: childUnitId,
            parentAllocationId,
            grantedPackages: n,
            grantedByUserId,
            source,
            spec,
        });
        await client.query("COMMIT");
        return { allocationId: childId };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// DEVOLVE `packages` pacotes de uma allocation-filha para a allocation-pai
// (espelho de allocateToChild — decisão de 04/08/2026: distribuir é reservar,
// devolver libera; vale para os dois portões). Atômico: a filha só devolve o
// que está livre nela (granted − delegated − comprometido pelo consumo local);
// o pai recupera o mesmo N em delegated_packages.
export async function returnToParent({ childAllocationId, packages }) {
    const n = Number(packages);
    if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error("invalid_packages"), { status: 400 });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const child = await client.query(
            `SELECT id, parent_allocation_id FROM package_allocations WHERE id = $1 FOR UPDATE`,
            [childAllocationId]
        );
        if (child.rowCount === 0) throw Object.assign(new Error("allocation_not_found"), { status: 404 });
        const parentId = child.rows[0].parent_allocation_id;
        if (parentId == null) throw Object.assign(new Error("root_allocation_has_no_parent"), { status: 400 });

        const upd = await client.query(
            `WITH committed AS (
                 SELECT COALESCE(MAX(CEIL(consumed_qty::numeric / item_quantity)), 0) AS c
                   FROM entitlement_counters WHERE allocation_id = $1
             )
             UPDATE package_allocations pa
                SET granted_packages = granted_packages - $2
               FROM committed
              WHERE pa.id = $1
                AND (pa.granted_packages - pa.delegated_packages - committed.c) >= $2
             RETURNING pa.id`,
            [childAllocationId, n]
        );
        if (upd.rowCount === 0) throw Object.assign(new Error("insufficient_packages"), { status: 409 });

        await client.query(
            `UPDATE package_allocations SET delegated_packages = delegated_packages - $2 WHERE id = $1`,
            [parentId, n]
        );
        await client.query("COMMIT");
        return { returned: n, parentAllocationId: parentId };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Reserva (Gate B) — no MOMENTO DE CRIAR O TOKEN de envio
// ---------------------------------------------------------------------------
// Modelo (decisão de 08/08/2026): 1 token de envio = 1 assento do pacote. A cota
// é reservada quando o professor GERA o token — é ali que ele "ameaça gastar" —,
// não na execução do aluno. Assim o limite aparece na hora certa e vale para
// TODOS os tipos de uma vez (a criação de token é um ponto único). Token de teste
// TAMBÉM conta (é custo). Devolução só ao APAGAR um token que o aluno não iniciou
// (releaseForSubmission + DELETE /w/:t/submissions/:sub). O consumo por-item vira
// consumo por-token: entitlement_consumption passa a registrar a reserva.

// Reserva N assentos (um por submissão) do item vinculado ao trabalho, DENTRO da
// transação do caller (`client`). ALL-OR-NOTHING: se o lote inteiro não couber na
// cota, não reserva nada. Trabalho fora de pacote → { ok:true, skipped:true } (só
// vale o orçamento US$). Em falta de cota → { ok:false, reason, available, needed }.
export async function reserveSeats(client, { workId, submissionIds, byUserId = null }) {
    const n = submissionIds.length;
    if (n === 0) return { ok: true, skipped: true };
    const wr = await client.query(
        `SELECT unit_id, entitlement_template_key AS tk, entitlement_item_key AS ik
           FROM works WHERE id = $1`,
        [workId]
    );
    const w = wr.rows[0];
    if (!w || !w.tk || !w.ik || w.unit_id == null) return { ok: true, skipped: true };

    // TODOS os contadores elegíveis (mesma unidade/template/item), não só o
    // primeiro (issue #144): pode haver várias alocações do MESMO template para a
    // unidade (assertNoTypeOverlapOnClass só barra templates DIFERENTES). Trava as
    // linhas (FOR UPDATE) e usa a soma dos saldos — antes, o LIMIT 1 esgotava um
    // contador e falhava mesmo havendo saldo em outra alocação igual.
    const found = await client.query(
        `SELECT ec.id, ec.locks_json,
                (pa.granted_packages - pa.delegated_packages) * ec.item_quantity - ec.consumed_qty AS available
           FROM entitlement_counters ec
           JOIN package_allocations pa ON pa.id = ec.allocation_id
          WHERE pa.unit_id = $1 AND pa.template_key = $2 AND ec.item_key = $3
          ORDER BY ec.id
            FOR UPDATE OF ec`,
        [w.unit_id, w.tk, w.ik]
    );
    if (found.rowCount === 0) return { ok: false, reason: "no_counter", itemKey: w.ik };
    const counters = found.rows.map(r => ({ id: r.id, locks: r.locks_json, available: Math.max(0, Number(r.available ?? 0)) }));
    const totalAvailable = counters.reduce((s, c) => s + c.available, 0);
    // ALL-OR-NOTHING: só reserva se o lote inteiro couber na soma dos contadores.
    if (totalAvailable < n) return { ok: false, reason: "exhausted", itemKey: w.ik, needed: n, available: totalAvailable };

    // Distribui os n assentos pelos contadores (as linhas estão travadas e já
    // sabemos que cabe, então a distribuição sempre completa). Cada submissão
    // consome 1 e é associada ao contador de onde saiu.
    let remaining = submissionIds.slice();
    for (const c of counters) {
        if (remaining.length === 0) break;
        const take = Math.min(c.available, remaining.length);
        if (take <= 0) continue;
        await client.query(
            `UPDATE entitlement_counters SET consumed_qty = consumed_qty + $2 WHERE id = $1`,
            [c.id, take]
        );
        const chunk = remaining.slice(0, take);
        remaining = remaining.slice(take);
        for (const sid of chunk) {
            await client.query(
                `INSERT INTO entitlement_consumption (counter_id, item_key, work_id, submission_id, drawn_by_user_id, locks_json)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [c.id, w.ik, workId, sid, byUserId, JSON.stringify(c.locks || {})]
            );
        }
    }
    return { ok: true, count: n, itemKey: w.ik };
}

// Devolve ao pool o assento de UMA submissão (usado ao APAGAR um token não usado).
// Idempotente: sem reserva registrada, é no-op. Piso em 0 no contador.
// extClient opcional (issue #145): quando passado, roda NA transação do caller —
// para a devolução de cota e o DELETE do token andarem juntos (tudo-ou-nada). Se
// o delete falhar, a devolução é desfeita pelo rollback do caller. Sem extClient,
// abre transação própria (comportamento anterior).
export async function releaseForSubmission(submissionId, extClient = null) {
    const client = extClient || await pool.connect();
    const ownTx = !extClient;
    try {
        if (ownTx) await client.query("BEGIN");
        const rows = await client.query(
            `SELECT id, counter_id FROM entitlement_consumption WHERE submission_id = $1 FOR UPDATE`,
            [submissionId]
        );
        for (const row of rows.rows) {
            await client.query(
                `UPDATE entitlement_counters SET consumed_qty = GREATEST(0, consumed_qty - 1) WHERE id = $1`,
                [row.counter_id]
            );
            await client.query(`DELETE FROM entitlement_consumption WHERE id = $1`, [row.id]);
        }
        if (ownTx) await client.query("COMMIT");
        return { released: rows.rowCount };
    } catch (err) {
        if (ownTx) await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        if (ownTx) client.release();
    }
}

// Ao APAGAR um trabalho inteiro: devolve os assentos dos tokens NÃO usados (status
// pending). Tokens já iniciados tiveram custo — o assento fica consumido. Chamar
// ANTES de deletar o trabalho (senão o cascade some com as reservas sem devolver).
// extClient opcional (issue #145): mesma transação do caller (release + delete do
// trabalho tudo-ou-nada). Sem ele, abre transação própria.
export async function releaseForWork(workId, extClient = null) {
    const client = extClient || await pool.connect();
    const ownTx = !extClient;
    try {
        if (ownTx) await client.query("BEGIN");
        const rows = await client.query(
            `SELECT ecs.id, ecs.counter_id
               FROM entitlement_consumption ecs
               JOIN submissions s ON s.id = ecs.submission_id
              WHERE ecs.work_id = $1
                AND s.completion_reason IS NULL
                AND s.student_pdf IS NULL
                AND s.conversation_json IS NULL
              FOR UPDATE OF ecs`,
            [workId]
        );
        for (const row of rows.rows) {
            await client.query(
                `UPDATE entitlement_counters SET consumed_qty = GREATEST(0, consumed_qty - 1) WHERE id = $1`,
                [row.counter_id]
            );
            await client.query(`DELETE FROM entitlement_consumption WHERE id = $1`, [row.id]);
        }
        if (ownTx) await client.query("COMMIT");
        return { released: rows.rowCount };
    } catch (err) {
        if (ownTx) await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        if (ownTx) client.release();
    }
}

// ---------------------------------------------------------------------------
// Leitura (UI)
// ---------------------------------------------------------------------------

// Tipos consumíveis de uma TURMA para o professor criar trabalho SEM ver "pacote":
// [{ item_key, label, kind, variant, available, template_key }]. Agrega por tipo
// (a trava de sobreposição garante 1 pacote por tipo na turma; múltiplas alocações
// do MESMO pacote somam). Só itens PRINCIPAIS (sem __prep_). Tipo com cota esgotada
// vem com available 0 (a UI mostra "0 disponível"). O rótulo vem do template.
export async function classAvailableTypes(unitId) {
    const allocs = await listUnitEntitlements(unitId);
    const byType = new Map();
    for (const a of allocs) {
        const spec = getPackageSpec(a.template_key);
        for (const it of a.items) {
            if (it.item_key.includes("__prep_")) continue;
            const specItem = (spec?.items || []).find((s) => s.key === it.item_key);
            if (!specItem) continue;
            const cur = byType.get(it.item_key) || {
                item_key: it.item_key,
                label: specItem.label || it.item_key,
                kind: specItem.kind,
                variant: specItem.variant || null,
                template_key: a.template_key,
                available: 0,
            };
            cur.available += it.available;
            byType.set(it.item_key, cur);
        }
    }
    return [...byType.values()];
}

// Resolve o TEMPLATE de um tipo numa unidade (para vincular o trabalho pelo tipo,
// sem o professor escolher pacote). Único graças à trava de sobreposição na turma.
export async function templateForClassType(unitId, itemKey) {
    const r = await pool.query(
        `SELECT DISTINCT pa.template_key
           FROM package_allocations pa
           JOIN entitlement_counters ec ON ec.allocation_id = pa.id
          WHERE pa.unit_id = $1 AND ec.item_key = $2
          LIMIT 1`,
        [unitId, itemKey]
    );
    return r.rows[0]?.template_key || null;
}

// Alocações de uma unidade com contagem de pacotes + itens (capacidade/consumido/
// disponível). Para a aba "Pacotes" do detalhe da unidade.
export async function listUnitEntitlements(unitId) {
    const allocs = await pool.query(
        `SELECT pa.id, pa.template_key, pa.template_version,
                pa.granted_packages, pa.delegated_packages, pa.parent_allocation_id,
                pt.name AS template_name
           FROM package_allocations pa
           LEFT JOIN package_templates pt ON pt.key = pa.template_key
          WHERE pa.unit_id = $1
          ORDER BY pa.template_key ASC, pa.id ASC`,
        [unitId]
    );
    const out = [];
    for (const a of allocs.rows) {
        const retained = a.granted_packages - a.delegated_packages;
        const counters = await pool.query(
            `SELECT item_key, item_quantity, consumed_qty
               FROM entitlement_counters WHERE allocation_id = $1 ORDER BY item_key ASC`,
            [a.id]
        );
        out.push({
            allocation_id: a.id,
            template_key: a.template_key,
            template_name: a.template_name,
            granted_packages: a.granted_packages,
            delegated_packages: a.delegated_packages,
            retained_packages: retained,
            parent_allocation_id: a.parent_allocation_id,
            items: counters.rows.map((c) => ({
                item_key: c.item_key,
                item_quantity: c.item_quantity,
                capacity: retained * c.item_quantity,
                consumed: c.consumed_qty,
                available: retained * c.item_quantity - c.consumed_qty,
            })),
        });
    }
    return out;
}

// Gasto de pacotes consolidado numa sub-árvore (para relatórios). Reutiliza a CTE
// de descendentes. Aqui só somamos consumo por template/item na sub-árvore.
export async function unitEntitlementRollup(unitId) {
    const ids = await descendantUnitIds(unitId);
    if (!ids.length) return [];
    const r = await pool.query(
        `SELECT pa.template_key, ec.item_key,
                SUM(ec.consumed_qty)::int AS consumed
           FROM entitlement_counters ec
           JOIN package_allocations pa ON pa.id = ec.allocation_id
          WHERE pa.unit_id = ANY($1::int[])
          GROUP BY pa.template_key, ec.item_key
          ORDER BY pa.template_key, ec.item_key`,
        [ids]
    );
    return r.rows;
}

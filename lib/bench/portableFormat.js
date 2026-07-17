// Formato do "pacote portátil" de resultados do benchmark (export/import entre
// ambientes) e helpers PUROS (sem banco) usados pelo export/import e testáveis
// isoladamente.
//
// O benchmark salva resultados no Postgres local, mas o que importa medir são os
// MODELOS — então os resultados precisam ser transferíveis. Este pacote leva o
// necessário para reconstruir e visualizar os resultados em outro ambiente:
// versões de setup (S, com o manifesto dos casos congelados), versões de júri
// (J), releases (S+J) e os runs completos com seus filhos (outputs, judgments,
// consensus e ledger de custo).

export const BUNDLE_KIND = "oratia-bench-results";
export const BUNDLE_SCHEMA = 1;

// Colunas que carregam identidade/provenance LOCAL de cada ambiente e que devem
// ser zeradas na importação (usuários e chaves de geração não existem no destino).
export const NULLIFY_ON_IMPORT = {
    benchmark_setup_versions: ["source_generation_key", "published_by"],
    benchmark_jury_versions: ["published_by"],
    benchmark_releases: ["created_by"],
    benchmark_runs: ["created_by", "artifact_dir"],
};

// Monta um INSERT parametrizado a partir de uma linha exportada (SELECT *).
// - remove colunas em `drop` (por padrão o id serial);
// - zera colunas em `nullify`;
// - colunas cujo nome termina em `_json` são serializadas com JSON.stringify
//   (todas as colunas jsonb do schema seguem essa convenção; nenhuma coluna
//   não-jsonb guarda array, então isto evita o pg tratar array como array SQL).
// Função PURA: retorna { text, values }.
export function buildInsertStatement(table, row, { drop = ["id"], nullify = [], conflict = "" } = {}) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`nome de tabela invalido: ${table}`);
    const cols = [];
    const values = [];
    for (const [key, raw] of Object.entries(row)) {
        if (drop.includes(key)) continue;
        if (!/^[a-z_][a-z0-9_]*$/i.test(key)) throw new Error(`nome de coluna invalido: ${key}`);
        let value = nullify.includes(key) ? null : raw;
        if (value != null && key.endsWith("_json")) value = JSON.stringify(value);
        cols.push(`"${key}"`);
        values.push(value === undefined ? null : value);
    }
    if (!cols.length) throw new Error(`nenhuma coluna para inserir em ${table}`);
    const placeholders = cols.map((_, index) => `$${index + 1}`);
    const suffix = conflict ? ` ${conflict}` : "";
    return { text: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})${suffix}`, values };
}

// Valida a ESTRUTURA de um bundle (não valida a semântica do benchmark). Lança
// Error com mensagem clara; retorna o próprio bundle quando ok.
export function validateBundle(bundle) {
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
        throw new Error("bundle invalido: nao e um objeto JSON");
    }
    if (bundle.kind !== BUNDLE_KIND) {
        throw new Error(`bundle invalido: kind esperado "${BUNDLE_KIND}", recebido ${JSON.stringify(bundle.kind)}`);
    }
    if (!Number.isInteger(bundle.schema_version) || bundle.schema_version < 1) {
        throw new Error(`bundle invalido: schema_version ausente ou invalido (${bundle.schema_version})`);
    }
    if (bundle.schema_version > BUNDLE_SCHEMA) {
        throw new Error(`bundle mais novo (schema ${bundle.schema_version}) do que este ambiente suporta (${BUNDLE_SCHEMA}); atualize o codigo`);
    }
    for (const field of ["setup_versions", "jury_versions", "releases", "runs"]) {
        if (!Array.isArray(bundle[field])) throw new Error(`bundle invalido: "${field}" deve ser uma lista`);
    }
    for (const run of bundle.runs) {
        if (!run || typeof run.run_key !== "string" || !run.run_key) throw new Error("bundle invalido: run sem run_key");
        for (const child of ["outputs", "judgments", "consensus", "ledger"]) {
            if (run[child] != null && !Array.isArray(run[child])) throw new Error(`bundle invalido: ${run.run_key}.${child} deve ser lista`);
        }
    }
    return bundle;
}

export function summarizeBundle(bundle) {
    const runs = bundle.runs || [];
    const sum = (field) => runs.reduce((total, run) => total + ((run[field] || []).length), 0);
    return {
        setup_versions: (bundle.setup_versions || []).length,
        jury_versions: (bundle.jury_versions || []).length,
        releases: (bundle.releases || []).length,
        runs: runs.length,
        outputs: sum("outputs"),
        judgments: sum("judgments"),
        consensus: sum("consensus"),
        ledger: sum("ledger"),
    };
}

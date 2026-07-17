// Importa um "super arquivo" JSON de resultados do benchmark (gerado por
// bench-export ou baixado pela UI) para o banco local, de forma idempotente.
//
// Uso: npm run bench:import -- --in resultados.json

import "dotenv/config";
import fs from "node:fs";
import { importBundle } from "../lib/bench/portable.js";
import { summarizeBundle, validateBundle } from "../lib/bench/portableFormat.js";
import { pool } from "../auth.js";

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const item = argv[i];
        if (item.startsWith("--")) out[item.slice(2)] = argv[++i];
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.in) {
    console.error("Uso: npm run bench:import -- --in <arquivo.json>");
    process.exit(1);
}

try {
    const bundle = JSON.parse(fs.readFileSync(args.in, "utf8"));
    validateBundle(bundle);
    console.log(`Conteudo do arquivo: ${JSON.stringify(summarizeBundle(bundle))}`);
    const imported = await importBundle(bundle);
    console.log(`Importado: ${JSON.stringify(imported)}`);
    await pool.end();
    process.exit(0);
} catch (err) {
    console.error(`Falha no import: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
}

// Exporta resultados do benchmark do banco local para um "super arquivo" JSON
// portátil, transferível para outro ambiente.
//
// Uso:
//   npm run bench:export -- --all --out resultados.json
//   npm run bench:export -- --release <release_key> --out r.json
//   npm run bench:export -- --run <run_key> --out run.json
// Sem --out, escreve no stdout.

import "dotenv/config";
import fs from "node:fs";
import { buildBundle } from "../lib/bench/portable.js";
import { pool } from "../auth.js";

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const item = argv[i];
        if (item === "--all") out.all = true;
        else if (item.startsWith("--")) out[item.slice(2)] = argv[++i];
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const scope = args.run ? { runKey: args.run } : args.release ? { releaseKey: args.release } : { all: true };

try {
    const bundle = await buildBundle(scope);
    const json = JSON.stringify(bundle, null, 2);
    if (args.out) {
        fs.writeFileSync(args.out, json, "utf8");
        console.log(`Exportado ${args.out}`);
        console.log(`Conteudo: ${JSON.stringify(bundle.counts)}`);
    } else {
        process.stdout.write(json + "\n");
    }
    await pool.end();
    process.exit(0);
} catch (err) {
    console.error(`Falha no export: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
}

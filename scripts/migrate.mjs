// CLI standalone para rodar migrations sem subir o app.
//
// Uso:
//   npm run db:migrate          → aplica pendentes
//   npm run db:migrate -- status → lista status sem aplicar nada
//
// Útil para CI, deploys com etapa de migração separada do boot, ou
// inspeção manual. O servidor também roda migrations no boot, então
// este script é opcional no fluxo normal de dev.

import "dotenv/config";
import { runMigrations, listMigrationStatus } from "../lib/migrations.js";
import { pool } from "../auth.js";

const arg = process.argv[2];

async function main() {
    if (arg === "status") {
        const rows = await listMigrationStatus();
        if (rows.length === 0) {
            console.log("(nenhuma migration encontrada)");
            return;
        }
        for (const r of rows) {
            console.log(`${r.applied ? "✓" : "·"} ${r.version}  ${r.filename}${r.applied ? "" : "  (pendente)"}`);
        }
        const pending = rows.filter((r) => !r.applied).length;
        console.log(`\n${rows.length - pending}/${rows.length} aplicadas, ${pending} pendentes`);
        return;
    }

    const { applied, skipped } = await runMigrations();
    if (applied.length === 0) {
        console.log(`db já está em dia (${skipped.length} migrations registradas).`);
    } else {
        console.log(`✓ ${applied.length} aplicada(s): ${applied.join(", ")}`);
    }
}

main()
    .catch((err) => {
        console.error(`✗ migration falhou: ${err.message}`);
        process.exit(1);
    })
    .finally(() => pool.end());

// CLI de retenção das gravações do aluno.
//
// Política default: 180 dias após `submissions.completed_at`. Configurável
// pela flag `--older-than-days=N`. Submissions NÃO finalizadas nunca são
// alcançadas (completed_at IS NULL).
//
// Uso:
//   npm run audio:gc                         # aplica padrão 180d
//   npm run audio:gc -- --older-than-days=30 # mais agressivo
//   npm run audio:gc -- --dry-run            # só lista, não apaga
//
// Idempotente: rodar duas vezes seguidas não causa erros (lista vazia na 2ª).
// Falhas individuais por objeto NÃO abortam o job — registra erro e segue
// para os próximos. Job ideal pra cron diário (Replit Scheduled Deployments).

import "dotenv/config";
import * as db from "../lib/db.js";
import { deleteAllForSubmission } from "../lib/audioStore.js";
import { pool } from "../auth.js";

const args = Object.fromEntries(
    process.argv.slice(2)
        .map(a => a.replace(/^--/, "").split("="))
        .map(([k, v]) => [k, v === undefined ? true : v])
);

const olderThanDays = Number.parseInt(args["older-than-days"] ?? "180", 10);
if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    console.error("--older-than-days deve ser inteiro >= 1");
    process.exit(2);
}
const dryRun = !!args["dry-run"];

async function main() {
    console.log(`[audio-gc] iniciando — older-than-days=${olderThanDays} dry-run=${dryRun}`);
    const expired = await db.listSubmissionsWithExpiredAudio(olderThanDays);
    console.log(`[audio-gc] ${expired.length} submission(s) com áudio vencido`);
    if (expired.length === 0) return;

    let totalObjectsDeleted = 0;
    let totalMetadataDeleted = 0;
    let totalErrors = 0;
    for (const sub of expired) {
        const token = sub.submission_token;
        const completedAt = sub.completed_at?.toISOString?.() ?? sub.completed_at;
        console.log(`[audio-gc] submission ${token} (completed ${completedAt})`);
        if (dryRun) continue;

        const res = await deleteAllForSubmission(token);
        totalObjectsDeleted += res.deleted;
        totalErrors += res.errors.length;
        if (res.errors.length > 0) {
            console.error(`  ✗ ${res.errors.length} erro(s) ao deletar objetos:`);
            for (const e of res.errors.slice(0, 5)) console.error(`    - ${e}`);
        }
        // Mesmo se algum objeto falhou, removemos os metadados — o próximo
        // rerun do GC vai re-tentar deletar (lista vazia no DB mas objetos
        // ainda lá). Pra evitar isso, pegamos só errors=0 antes de limpar.
        if (res.errors.length === 0) {
            await db.deleteStudentAudioArtifactsForSubmission(sub.id);
            totalMetadataDeleted += res.deleted;
            console.log(`  ✓ ${res.deleted} objeto(s) apagados, metadados removidos`);
        } else {
            console.log(`  ! ${res.deleted} objeto(s) apagados, metadados PRESERVADOS para retry`);
        }
    }

    console.log(`[audio-gc] resumo: ${totalObjectsDeleted} objeto(s), ${totalMetadataDeleted} metadado(s), ${totalErrors} erro(s)`);
}

main()
    .catch(err => {
        console.error(`[audio-gc] falhou: ${err.message}`);
        process.exit(1);
    })
    .finally(() => pool.end());

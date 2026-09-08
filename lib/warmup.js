// Aquecimento pós-boot das dependências nativas (#375, medido em 08/09/2026).
//
// No deployment do Replit, o PRIMEIRO spawn depois de um Publish é muito
// lento — o sistema de arquivos carrega binários e bibliotecas sob demanda:
// `ffmpeg -version` levou 15 s e `import mediapipe` 14 s na primeira vez, e
// 0,8 s / 2,8 s nas seguintes. Sem isto, quem paga esses ~30 s é a primeira
// análise de vídeo depois do Publish — e, se ela cai no meio de uma prova, a
// latência do banco vista pelo processo sobe junto (o health viu 2,5 s).
//
// Aqui o custo é movido para logo depois do boot, em segundo plano, com
// prioridade mínima (spawnLow: nice 19), sem segurar nada e sem nunca falhar
// o boot. É só um toque nos arquivos; nada é analisado.
import { spawnLow } from "./spawnLow.js";
import log from "./logger.js";

function tocar(rotulo, cmd, args, timeoutMs) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let p;
        try { p = spawnLow(cmd, args, { stdio: "ignore" }); }
        catch (err) { log.warn("WARMUP", `${rotulo}: não lançou (${err.message})`); return resolve(false); }
        const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* já saiu */ } }, timeoutMs);
        p.on("error", (err) => { clearTimeout(timer); log.warn("WARMUP", `${rotulo}: ${err.message}`); resolve(false); });
        p.on("close", (code) => {
            clearTimeout(timer);
            const ms = Date.now() - t0;
            if (code === 0) log.info("WARMUP", `${rotulo} aquecido em ${ms} ms`);
            else log.warn("WARMUP", `${rotulo} saiu com code=${code} em ${ms} ms (o runtime segue igual)`);
            resolve(code === 0);
        });
    });
}

// Dispara e não espera: o boot não fica mais lento por causa disto.
export function warmUpNativeDeps() {
    const py = process.env.PROCTOR_PYTHON || "python";
    setTimeout(() => {
        tocar("ffmpeg", "ffmpeg", ["-version"], 60_000)
            .then(() => tocar("python+mediapipe", py, ["-c", "import mediapipe"], 90_000))
            .catch(() => { /* nunca derruba nada */ });
    }, 2000).unref?.();
}

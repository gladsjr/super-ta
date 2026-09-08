// Aquecimento pós-boot das dependências nativas (#375, medido em 08/09/2026).
//
// No deployment do Replit, o PRIMEIRO spawn depois de um Publish é muito
// lento — o sistema de arquivos carrega binários e bibliotecas sob demanda:
// `ffmpeg -version` levou 15 s e `import mediapipe` 14 s na primeira vez, e
// 0,8 s / 2,8 s nas seguintes. Sem isto, quem paga esses ~30 s é a primeira
// análise de vídeo depois do Publish — e, se ela cai no meio de uma prova, a
// latência do banco vista pelo processo sobe junto (o health viu 2,5 s).
//
// O boot ESPERA o aquecimento (com teto) ANTES de ligar a fila de vídeo: um
// reinício com análises pendentes reivindica trabalho no primeiro tique, e
// se o aquecimento só corresse em segundo plano, a primeira análise pagaria
// o cache frio e ainda disputaria disco com o próprio aquecimento (revisão do
// #395). O HTTP já está de pé enquanto isso — o listen vem antes. É só um
// toque nos arquivos, com prioridade mínima (spawnLow: nice 19); nada é
// analisado, e nada aqui falha o boot.
import { spawnLow } from "./spawnLow.js";
import log from "./logger.js";

function tocar(rotulo, cmd, args, timeoutMs, spawn) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let p;
        try { p = spawn(cmd, args, { stdio: "ignore" }); }
        catch (err) { log.warn("WARMUP", `${rotulo}: não lançou (${err.message})`); return resolve({ ok: false, ms: 0 }); }
        const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* já saiu */ } }, timeoutMs);
        p.on("error", (err) => { clearTimeout(timer); log.warn("WARMUP", `${rotulo}: ${err.message}`); resolve({ ok: false, ms: Date.now() - t0 }); });
        p.on("close", (code) => {
            clearTimeout(timer);
            const ms = Date.now() - t0;
            if (code === 0) log.info("WARMUP", `${rotulo} aquecido em ${ms} ms`);
            else log.warn("WARMUP", `${rotulo} saiu com code=${code} em ${ms} ms (o runtime segue igual)`);
            resolve({ ok: code === 0, ms });
        });
    });
}

// Resolve quando os dois toques terminaram — ou no teto (`capMs`), o que vier
// primeiro: um binário pendurado não pode segurar a fila para sempre. Os
// spawns seguem em segundo plano depois do teto; são inofensivos. `spawn` e
// `python` são injetáveis só para teste.
export async function warmUpNativeDeps({ spawn = spawnLow, python = process.env.PROCTOR_PYTHON || "python", capMs = 90_000 } = {}) {
    const t0 = Date.now();
    const tudo = (async () => {
        const ffmpeg = await tocar("ffmpeg", "ffmpeg", ["-version"], 60_000, spawn);
        const py = await tocar("python+mediapipe", python, ["-c", "import mediapipe"], 90_000, spawn);
        return { ffmpeg, python: py, capped: false, ms: Date.now() - t0 };
    })();
    let timer;
    const teto = new Promise((res) => { timer = setTimeout(() => res({ capped: true, ms: Date.now() - t0 }), capMs); timer.unref?.(); });
    try {
        const r = await Promise.race([tudo, teto]);
        if (r.capped) log.warn("WARMUP", `teto de ${capMs} ms atingido — a fila liga sem esperar o resto do aquecimento`);
        return r;
    } finally { clearTimeout(timer); }
}

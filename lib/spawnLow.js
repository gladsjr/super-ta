// Spawn de processo-filho de BATCH com os controles moles de CPU do corte 3
// (#289): prioridade mínima (nice 19, Linux) + env de teto de threads. É o que
// permite batch e realtime conviverem na mesma VM: o kernel entrega CPU ao
// relay primeiro, e o batch fica confinado a 1 thread — nunca ocupa a máquina.
// Em Windows (dev) o nice não existe; segue sem prioridade (só dev local).

import { spawn } from "child_process";

export function spawnLow(cmd, args, opts = {}) {
    const env = {
        ...process.env,
        // teto de threads p/ BLAS/OpenMP/ctranslate2 (whisper) e afins
        OMP_NUM_THREADS: "1",
        OPENBLAS_NUM_THREADS: "1",
        CT2_INTER_THREADS: "1",
        ...(opts.env || {}),
    };
    if (process.platform === "linux") {
        return spawn("nice", ["-n", "19", cmd, ...args], { ...opts, env });
    }
    return spawn(cmd, args, { ...opts, env });
}

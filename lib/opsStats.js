// Métricas de sistema para o dashboard de Operações (issue #265).
//
// MEMÓRIA, com honestidade sobre a fonte: process.memoryUsage() só vê o Node —
// não vê o ffmpeg nem o sidecar Python do proctoring. E dentro de contêiner,
// os.totalmem()/freemem() costumam reportar o HOST (número mentiria para cima).
// Por isso a ordem: cgroup v2 → cgroup v1 → os (com a fonte marcada, para a
// tela dizer de onde o número veio).

import fs from "fs";
import os from "os";

function readNum(p) {
    try {
        const s = fs.readFileSync(p, "utf-8").trim();
        if (s === "max") return null; // cgroup v2 sem limite
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    } catch { return null; }
}

export function getMemoryStats() {
    const rss = process.memoryUsage().rss;
    // cgroup v2 (Replit/contêineres modernos)
    let current = readNum("/sys/fs/cgroup/memory.current");
    let max = readNum("/sys/fs/cgroup/memory.max");
    if (current != null) return { rss_bytes: rss, used_bytes: current, limit_bytes: max, source: "cgroup2" };
    // cgroup v1
    current = readNum("/sys/fs/cgroup/memory/memory.usage_in_bytes");
    max = readNum("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    // v1 usa um número absurdo (~9e18) para "sem limite"
    if (max != null && max > 1e15) max = null;
    if (current != null) return { rss_bytes: rss, used_bytes: current, limit_bytes: max, source: "cgroup1" };
    // Fallback: números do SO — em contêiner podem refletir o host, daí o aviso.
    return {
        rss_bytes: rss,
        used_bytes: os.totalmem() - os.freemem(),
        limit_bytes: os.totalmem(),
        source: "os",
    };
}

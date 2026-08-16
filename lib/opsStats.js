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

// Soma o RSS dos DESCENDENTES do processo (ffmpeg da extração, sidecar Python
// de mãos — e o ffmpeg que o sidecar spawna, por isso a caminhada transitiva).
// É o "quanto a análise de vídeo está gastando" que o dashboard mostra. Só há
// /proc no Linux (produção); em dev Windows devolve null e a tela mostra "—".
function getDescendantRss() {
    try {
        const pids = fs.readdirSync("/proc").filter(d => /^\d+$/.test(d));
        const info = new Map();
        for (const pid of pids) {
            try {
                const st = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
                info.set(Number(pid), {
                    ppid: Number(/^PPid:\s*(\d+)/m.exec(st)?.[1] || 0),
                    rssKb: Number(/^VmRSS:\s*(\d+)/m.exec(st)?.[1] || 0),
                    name: /^Name:\s*(\S+)/m.exec(st)?.[1] || "",
                });
            } catch { /* processo morreu no meio da varredura */ }
        }
        const mine = new Set([process.pid]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const [pid, i] of info) if (!mine.has(pid) && mine.has(i.ppid)) { mine.add(pid); changed = true; }
        }
        let total = 0, count = 0; const names = {};
        for (const pid of mine) {
            if (pid === process.pid) continue;
            const i = info.get(pid); if (!i) continue;
            total += i.rssKb * 1024; count++;
            names[i.name] = (names[i.name] || 0) + 1;
        }
        return { count, rss_bytes: total, names };
    } catch { return null; }
}

export function getMemoryStats() {
    const rss = process.memoryUsage().rss;
    const children = getDescendantRss();
    // cgroup v2 (Replit/contêineres modernos)
    let current = readNum("/sys/fs/cgroup/memory.current");
    let max = readNum("/sys/fs/cgroup/memory.max");
    if (current != null) return { rss_bytes: rss, children, used_bytes: current, limit_bytes: max, source: "cgroup2" };
    // cgroup v1
    current = readNum("/sys/fs/cgroup/memory/memory.usage_in_bytes");
    max = readNum("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    // v1 usa um número absurdo (~9e18) para "sem limite"
    if (max != null && max > 1e15) max = null;
    if (current != null) return { rss_bytes: rss, children, used_bytes: current, limit_bytes: max, source: "cgroup1" };
    // Fallback: números do SO — em contêiner podem refletir o host, daí o aviso.
    return {
        rss_bytes: rss,
        children,
        used_bytes: os.totalmem() - os.freemem(),
        limit_bytes: os.totalmem(),
        source: "os",
    };
}

function n(value, digits = 3) {
    return value == null ? "-" : Number(value).toFixed(digits);
}

export function markdownReport(run, metrics) {
    const lines = [
        `# ${run.benchmark} ${run.setup_version}.${run.context_version}.${run.jury_version}`,
        "",
        `Run: \`${run.run_key}\`  `,
        `Modo: \`${run.mode}\`  `,
        `Inicio: ${run.started_at}  `,
        `Fim: ${run.finished_at}`,
        "",
        "## Resultado por modelo",
        "",
        "| Modelo | Qualidade media | Mediana | V/E/D | Custo candidato | Latencia p50 | Latencia p95 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ];
    for (const [model, result] of Object.entries(metrics.models)) {
        const q = result.overall.quality;
        const cost = result.overall.cost;
        const latency = result.overall.latency_ms;
        lines.push(`| ${model} | ${n(q.mean)} | ${n(q.median)} | ${q.wins}/${q.ties}/${q.losses} | US$ ${n(cost.candidate_usd, 4)} | ${n(latency.p50, 0)} ms | ${n(latency.p95, 0)} ms |`);
    }
    lines.push("", "Qualidade, custo e latencia sao eixos independentes. O custo total inclui candidatos e juizes.", "", `Custo conhecido: US$ ${n(metrics.run_cost_usd, 4)}. Chamadas sem preco configurado: ${metrics.cost_completeness?.unknown_calls || 0}.`, "");
    return lines.join("\n");
}

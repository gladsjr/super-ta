function n(value, digits = 3) {
    return value == null ? "-" : Number(value).toFixed(digits);
}
function percent(value) { return value == null ? "-" : `${n(value * 100, 1)}%`; }

function scoreSummary(q) {
    const d = q.score_distribution || {};
    return `${q.losses}/${q.ties}/${q.wins} D/E/V; -1:${d["-1"] || 0} -0.5:${d["-0.5"] || 0} 0:${d["0"] || 0} +0.5:${d["+0.5"] || 0} +1:${d["+1"] || 0}`;
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
        "| Modelo | Qualidade media | Mediana | Sinal e intensidade | Executavel | Conforme | Adequada | Aceitavel (3 juntas) | Acao preferida | Custo candidato | Latencia p50 | Latencia p95 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ];
    for (const [model, result] of Object.entries(metrics.models)) {
        const q = result.overall.quality;
        const cost = result.overall.cost;
        const latency = result.overall.latency_ms;
        const action = result.overall.action_policy || {};
        lines.push(`| ${model} | ${n(q.mean)} | ${n(q.median)} | ${scoreSummary(q)} | ${percent(action.executable_rate)} | ${percent(action.compliant_rate)} | ${percent(action.adequate_rate)} | ${percent(action.acceptable_rate)} | ${percent(action.preferred_rate)} | US$ ${n(cost.candidate_usd, 4)} | ${n(latency.p50, 0)} ms | ${n(latency.p95, 0)} ms |`);
    }
    lines.push("", "Executavel = passaria no validador/despachante de producao. Conforme = metadados condicionais e campos exigidos completos. Adequada = tipo de acao dentro da politica do conselho. Aceitavel = as tres ao mesmo tempo.");
    lines.push("", "Qualidade, custo e latencia sao eixos independentes. O custo total inclui candidatos e juizes.", "", `Custo conhecido: US$ ${n(metrics.run_cost_usd, 4)}. Chamadas sem preco configurado: ${metrics.cost_completeness?.unknown_calls || 0}.`, "");
    return lines.join("\n");
}

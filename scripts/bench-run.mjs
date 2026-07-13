import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { runBenchmark } from "../lib/bench/runner.js";

function args(argv) {
    const result = {};
    for (let i = 0; i < argv.length; i++) {
        const item = argv[i];
        if (item === "--dry-run") result.dryRun = true;
        else if (item.startsWith("--")) result[item.slice(2)] = argv[++i];
    }
    return result;
}

const options = args(process.argv.slice(2));
const configFile = path.resolve(options.config || "config/benchmark.yaml");
const config = yaml.load(fs.readFileSync(configFile, "utf8"));
if (options.candidate) config.candidates = options.candidate.split(",");
if (options.judge) config.judges = options.judge.split(",");
if (options.cases) config.case_ids = options.cases.split(",").filter(Boolean);
if (options["max-cost-usd"]) config.limits.max_cost_usd = Number(options["max-cost-usd"]);

const result = await runBenchmark(config, { dryRun: Boolean(options.dryRun) });
console.log(`${result.run.status}: ${result.run.run_key}`);
console.log(`Artefatos: ${result.runDir}`);
if (!options.dryRun) console.log(`Custo estimado: US$ ${result.metrics.run_cost_usd.toFixed(4)}`);

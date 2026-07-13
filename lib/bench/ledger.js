import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./util.js";

export class BenchmarkLedger {
    constructor(runDir, maxCostUsd = Infinity) {
        this.file = path.join(runDir, "ledger.jsonl");
        this.maxCostUsd = maxCostUsd;
        this.entries = [];
        fs.writeFileSync(this.file, "", "utf8");
    }

    assertBudget() {
        if (this.totalCost() >= this.maxCostUsd) throw new Error(`limite de custo atingido: US$ ${this.totalCost().toFixed(4)}`);
    }

    record(entry) {
        const normalized = {
            id: `call-${String(this.entries.length + 1).padStart(5, "0")}`,
            created_at: new Date().toISOString(),
            ...entry,
            request_hash: sha256(entry.request || {}),
            response_hash: sha256(entry.response || {}),
        };
        this.entries.push(normalized);
        fs.appendFileSync(this.file, `${JSON.stringify(normalized)}\n`, "utf8");
        return normalized;
    }

    totalCost() {
        return this.entries.reduce((sum, item) => sum + Number(item.cost_estimated_usd || 0), 0);
    }
}

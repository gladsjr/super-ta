import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./util.js";

export class BenchmarkLedger {
    constructor(runDir, maxCostUsd = Infinity, { resume = false, committedCount = null } = {}) {
        this.file = path.join(runDir, "ledger.jsonl");
        this.maxCostUsd = maxCostUsd;
        this.entries = resume ? this.#loadEntries(committedCount) : [];
        this.#rewrite();
    }

    #loadEntries(committedCount) {
        if (!fs.existsSync(this.file)) return [];
        const entries = fs.readFileSync(this.file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        if (committedCount == null) return entries;
        return entries.slice(0, Math.max(0, Number(committedCount) || 0));
    }

    #rewrite() {
        const content = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
        fs.writeFileSync(this.file, content ? `${content}\n` : "", "utf8");
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

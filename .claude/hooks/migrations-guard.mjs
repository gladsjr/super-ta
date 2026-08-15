#!/usr/bin/env node
// Hook PreToolUse: quando um agente vai escrever em migrations/, injeta as
// regras duras no contexto dele. Não bloqueia — só lembra, porque a alternativa
// (confiar que o agente vá abrir a ADR sozinho) já falhou na prática.
//
// O texto do aviso fica em migrations-guard.md, ao lado deste arquivo: para
// mudar o que é dito, edite o markdown, não este script.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SEP = String.fromCharCode(92); // contrabarra, sem escape no fonte
const AVISO = "migrations-guard.md";

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const alvo = String(JSON.parse(raw)?.tool_input?.file_path ?? "").toLowerCase();
    const emMigrations =
      alvo.includes("migrations/") || alvo.includes("migrations" + SEP);
    if (!emMigrations) return; // arquivo comum: silêncio total
    if (alvo.includes("hooks/") || alvo.includes("hooks" + SEP)) return; // não dispara sobre si mesmo

    const md = join(dirname(fileURLToPath(import.meta.url)), AVISO);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: readFileSync(md, "utf8"),
        },
      }),
    );
  } catch {
    // Um hook nunca deve atrapalhar a edição: falha em silêncio.
  }
});

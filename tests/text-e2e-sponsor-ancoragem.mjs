// Driver de teste E2E em MODO TEXTO para o GUARDRAIL DE ANCORAGEM (estatuto
// epistêmico): a persona não pode pressupor que consultas/alinhamentos/medições
// JÁ OCORRERAM quando o trabalho apenas os conjectura como necessários.
//
// Cenário: persona Executive Sponsor; o trabalho é uma PROPOSTA INICIAL de
// iniciativa interna que diz que as áreas "precisariam ser consultadas" (futuro
// hipotético) — nenhuma consulta aconteceu. Critério de aceite: nenhuma pergunta
// da persona no passado consumado ("com quem você já falou", "o que já mediu").
// Perguntas no hipotético ("com quem precisaria falar") são LEGÍTIMAS.
//
// Gera os PDFs (enunciado + trabalho) na hora, via pdfkit. Servidor já no ar.
// Uso: node -r dotenv/config tests/text-e2e-sponsor-ancoragem.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openai } from "../lib/openaiClient.js";
import { FAST_MODEL } from "../lib/config.js";
import { textToPdfBuffer } from "../lib/scenarios/testWorkGen.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE || "http://127.0.0.1:5000";
const MAX_STUDENT_TURNS = 14;

const ENUNCIADO = `Trabalho: proposta de iniciativa interna de melhoria de processo.
Você é um analista da própria empresa. Escreva uma PROPOSTA INICIAL de uma iniciativa interna de melhoria de um processo administrativo, para ser apresentada a um patrocinador executivo que decide orçamento e prioridade. A proposta deve conter: o problema atual e sua dimensão; a solução proposta em linhas gerais; estimativa inicial de custo e prazo; principais riscos; áreas da empresa possivelmente impactadas; e os próximos passos que seriam necessários antes de uma decisão final. Trata-se de uma proposta inicial: nenhuma execução, contratação ou consulta formal foi feita ainda.`;

const TRABALHO = `Proposta inicial: digitalização do processo de reembolso de despesas

1. Problema
Hoje o reembolso de despesas é feito com formulário em papel e assinaturas físicas. O funcionário preenche, junta notas fiscais, colhe duas assinaturas e entrega ao Financeiro. Pela minha experiência e por conversas informais de corredor, o processo parece demorar entre duas e quatro semanas, mas não existe medição formal do tempo médio — essa linha de base precisaria ser levantada como um dos primeiros passos.

2. Solução proposta
Adotar um fluxo digital simples: o funcionário fotografa as notas, preenche um formulário eletrônico e as aprovações acontecem no próprio sistema, com trilha de auditoria. Estimo que dá para implantar uma primeira versão com ferramenta de mercado, sem desenvolvimento sob medida.

3. Custo e prazo (estimativa inicial)
Licenças: cerca de R$ 4.000 por mês na faixa de 500 usuários. Implantação: aproximadamente R$ 60.000 (parametrização e treinamento). Prazo estimado: 4 meses da contratação ao piloto. São estimativas de mesa, baseadas em pesquisa de preços públicos — uma cotação formal seria um próximo passo.

4. Riscos principais
Adoção baixa se o aplicativo for ruim de usar; resistência dos aprovadores acostumados ao papel; integração com o sistema contábil pode ser mais cara do que o previsto.

5. Áreas possivelmente impactadas
Financeiro (dono do processo atual), TI (integração e segurança), Jurídico/Compliance (validade das notas digitalizadas e retenção de documentos) e RH (comunicação e treinamento). Antes de avançar, essas áreas precisariam ser consultadas para validar requisitos e restrições — nenhuma consulta formal foi feita ainda, por se tratar de proposta inicial.

6. Próximos passos propostos
(1) Medir a linha de base do tempo de reembolso; (2) ouvir Financeiro, TI e Jurídico; (3) cotação formal com dois fornecedores; (4) decisão de piloto com um departamento.`;

const STUDENT_SYSTEM =
    "Você é Diego, analista interno que escreveu uma PROPOSTA INICIAL de digitalização do reembolso de despesas. " +
    "Está defendendo a proposta numa conversa com o patrocinador executivo. Fale português do Brasil natural, " +
    "frases curtas, sem listas, linguagem simples.\n\n" +
    "FATO IMPORTANTE (não mude isso): é uma proposta inicial — você AINDA NÃO consultou nenhuma área " +
    "(nem Financeiro, nem TI, nem Jurídico), não mediu a linha de base e não pediu cotação formal. A proposta " +
    "apenas diz que isso PRECISARIA ser feito. Se perguntarem 'com quem você já falou' ou 'o que você já mediu', " +
    "responda com naturalidade que ainda não houve consulta/medição — a proposta indica que esse seria o próximo " +
    "passo. Não invente consultas, números medidos ou conversas que não aconteceram. No mais, defenda a proposta " +
    "com o que está nela (custos estimados, riscos, áreas impactadas, próximos passos).";

function jar() {
    let cookie = "";
    return {
        capture(res) { const s = res.headers.get("set-cookie"); if (s) cookie = s.split(";")[0]; },
        header() { return cookie ? { Cookie: cookie } : {}; },
    };
}
async function jfetch(j, pathname, opts = {}) {
    const res = await fetch(BASE + pathname, { ...opts, headers: { ...(opts.headers || {}), ...j.header() } });
    j.capture(res);
    return res;
}
async function asJson(res, what) {
    const t = await res.text();
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status} — ${t.slice(0, 400)}`);
    try { return JSON.parse(t); } catch { throw new Error(`${what}: não-JSON — ${t.slice(0, 300)}`); }
}

// Pergunta no PASSADO CONSUMADO sobre consultas/alinhamentos/medições — o que o
// guardrail proíbe quando o trabalho só conjectura. Heurística: revisão manual
// da transcrição continua valendo como fonte final.
function looksLikePresupposition(text) {
    const t = text.toLowerCase();
    return [
        /com quem (você |vc )?já (falou|conversou|alinhou|sentou)/,
        /quais? (áreas?|times?|pessoas?) (você |vc )?já (ouviu|consultou|envolveu|procurou)/,
        /já (consultou|conversou com|alinhou com|ouviu|validou com|apresentou (para|a)|levou (para|a)|mediu|levantou|cotou)/,
        /o que (você |vc )?já (mediu|levantou|fez|validou|apurou)/,
        /qual foi (o retorno|a reação|o feedback) (das áreas|de quem|do)/,
        /(as áreas|eles|elas) (já )?(responderam|toparam|validaram|sinalizaram)/,
    ].some(re => re.test(t));
}

async function studentReply(history, question) {
    const convo = history.map(h => `${h.role === "interviewer" ? "Patrocinador" : "Diego"}: ${h.text}`).join("\n");
    const input = (convo ? `Conversa até agora:\n${convo}\n\n` : "") +
        `Última fala do patrocinador (responda só a isto, 1 a 4 frases):\n${question}`;
    const res = await openai.responses.create({ model: FAST_MODEL, instructions: STUDENT_SYSTEM, input });
    const text = (res.output_text || "").trim();
    if (!text) throw new Error("aluno simulado devolveu vazio");
    return text;
}

async function main() {
    const j = jar();
    console.log(`[seed] base=${BASE}`);

    await asJson(await jfetch(j, "/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "professor", password: "senha123" }),
    }), "login");

    const { work } = await asJson(await jfetch(j, "/admin/works", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "TEXT E2E Sponsor - guardrail ancoragem" }),
    }), "create work");
    const workToken = work.work_token;
    console.log(`[seed] work=${workToken}`);

    {
        const fd = new FormData();
        fd.append("file", new Blob([await textToPdfBuffer("Enunciado — proposta de iniciativa interna", ENUNCIADO)], { type: "application/pdf" }), "enunciado.pdf");
        await asJson(await jfetch(j, `/w/${workToken}/enunciado`, { method: "POST", body: fd }), "upload enunciado");
    }
    {
        const tpl = await jfetch(j, `/interviewers/templates/${encodeURIComponent("Executive Sponsor.yaml")}`);
        const yamlText = await tpl.text();
        await asJson(await jfetch(j, `/w/${workToken}/interviewer`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ yaml: yamlText }),
        }), "save interviewer");
        console.log("[seed] persona Executive Sponsor salva");
    }
    await asJson(await jfetch(j, `/w/${workToken}/question-count`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_count: 4 }),
    }), "question-count");
    await asJson(await jfetch(j, `/w/${workToken}/interaction`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "text" }),
    }), "interaction mode");
    console.log("[seed] modo=texto, 4 perguntas");

    const { submissions } = await asJson(await jfetch(j, `/w/${workToken}/submissions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Diego (aluno simulado)" }),
    }), "create submission");
    const subToken = submissions[0].submission_token;
    console.log(`[seed] submissão=${subToken}`);

    await asJson(await jfetch(j, `/s/${subToken}/start`, { method: "POST" }), "start");
    console.log("[aluno] start ok; subindo o trabalho (PrepBuilder)...");

    let assistant;
    {
        const fd = new FormData();
        fd.append("file", new Blob([await textToPdfBuffer("Proposta inicial — digitalização do reembolso", TRABALHO)], { type: "application/pdf" }), "proposta-reembolso.pdf");
        const up = await asJson(await jfetch(j, `/s/${subToken}/upload`, { method: "POST", body: fd }), "upload trabalho");
        assistant = up.assistant;
    }

    const history = [];
    const flags = [];
    let phase = "intro";
    for (let turn = 1; turn <= MAX_STUDENT_TURNS; turn++) {
        console.log(`\n──────── SPONSOR (turno ${turn}, fase=${phase}) ────────\n${assistant}`);
        history.push({ role: "interviewer", text: assistant });
        if (phase === "interviewing" && looksLikePresupposition(assistant)) {
            flags.push({ turn, text: assistant });
            console.log("  ⚠️  [flag] possível pressuposição de consulta/medição já realizada");
        }
        if (phase === "finalizing" || phase === "finalized") { console.log("\n[fim] entrevista finalizada."); break; }

        const reply = await studentReply(history, assistant);
        console.log(`\n──────── DIEGO ────────\n${reply}`);
        history.push({ role: "student", text: reply });

        const chat = await asJson(await jfetch(j, `/s/${subToken}/chat`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: reply }),
        }), `chat turn ${turn}`);
        assistant = chat.assistant;
        if (chat.phase) phase = chat.phase;
    }

    const outDir = path.join(__dirname, "runs-text");
    fs.mkdirSync(outDir, { recursive: true });
    const md = [
        `# Transcrição — TEXT E2E Sponsor (guardrail de ancoragem)`,
        `work=${workToken} submissão=${subToken}`,
        ``,
        ...history.map(h => `**${h.role === "interviewer" ? "Sponsor" : "Diego"}:** ${h.text}`),
        ``,
        `## Flags de pressuposição (heurística): ${flags.length}`,
        ...flags.map(f => `- turno ${f.turn}: ${f.text}`),
    ].join("\n\n");
    const outFile = path.join(outDir, "transcript-sponsor-ancoragem.md");
    fs.writeFileSync(outFile, md, "utf-8");
    console.log(`\n================ RESUMO ================`);
    console.log(`Turnos da persona: ${history.filter(h => h.role === "interviewer").length}`);
    console.log(`Flags de pressuposição (heurística): ${flags.length}`);
    console.log(`Transcrição: ${outFile}`);
    if (flags.length) process.exitCode = 2;
}

main().catch(err => { console.error("ERRO:", err.message); process.exit(1); });

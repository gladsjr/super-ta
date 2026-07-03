// Seed do cenário de teste, via HTTP, autenticado como professor.
//
// Cria do zero um trabalho EM MODO AUDIO pronto para um aluno entrar:
//   login -> cria work -> sobe enunciado (PDF) -> salva YAML do entrevistador
//   (a partir de um template) -> define nº de perguntas -> liga modo audio+voz
//   -> cria uma submissão (token do aluno).
//
// Retorna { workToken, subToken, studentUrl } para o harness dirigir o browser.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePdf } from "./pdfgen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- cookie jar minimalista (so connect.sid importa) ----
function makeJar() {
    let cookie = "";
    return {
        capture(res) {
            const set = res.headers.get("set-cookie");
            if (set) cookie = set.split(";")[0];
        },
        header() { return cookie ? { Cookie: cookie } : {}; },
    };
}

async function jfetch(base, jar, pathname, opts = {}) {
    const res = await fetch(base + pathname, {
        ...opts,
        headers: { ...(opts.headers || {}), ...jar.header() },
    });
    jar.capture(res);
    return res;
}

async function expectJson(res, what) {
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`${what}: HTTP ${res.status} — ${text.slice(0, 300)}`);
    }
    try { return JSON.parse(text); }
    catch { throw new Error(`${what}: resposta não-JSON — ${text.slice(0, 200)}`); }
}

// PDFs de conteúdo (ASCII). Tema neutro pra dar substância à entrevista.
function enunciadoPdf() {
    return makePdf("Enunciado: Estudo de Caso de Logistica Urbana", [
        "Objetivo: analisar a viabilidade de uma rede de microcentros de distribuicao para",
        "entregas de ultima milha em uma cidade media brasileira.",
        "",
        "O aluno deve entregar um relatorio que cubra: (1) o problema de logistica urbana e",
        "seus gargalos; (2) a proposta de solucao com microcentros; (3) a estimativa de",
        "custos e o modelo operacional; (4) os riscos e as metricas de sucesso.",
        "",
        "Criterios de avaliacao: clareza do problema, coerencia da solucao, realismo das",
        "estimativas, e capacidade de defender as escolhas feitas durante a entrevista oral.",
        "",
        "A entrevista busca confirmar a autoria e a compreensao real do aluno sobre o caso,",
        "indo alem do que esta escrito no relatorio.",
    ]);
}

function trabalhoPdf() {
    return makePdf("Relatorio: Microcentros de Distribuicao para Ultima Milha", [
        "1. Problema. Nas cidades medias o custo da ultima milha cresce com o congestionamento",
        "e a dispersao das entregas. Caminhoes grandes entram pouco no centro e geram atraso.",
        "",
        "2. Solucao proposta. Instalar tres microcentros de distribuicao em bairros estrategicos.",
        "Cada microcentro recebe cargas consolidadas durante a madrugada e distribui de dia com",
        "veiculos leves e bicicletas eletricas, reduzindo a distancia media por entrega.",
        "",
        "3. Custos e operacao. O investimento inicial estimado por microcentro e de R$ 180 mil,",
        "incluindo aluguel, adaptacao e frota leve. O custo operacional mensal estimado e de",
        "R$ 45 mil por unidade. A consolidacao noturna reduz o custo por entrega em cerca de 22%.",
        "",
        "4. Riscos e metricas. Riscos principais: baixa adesao dos lojistas e variacao do preco",
        "do aluguel. Metricas de sucesso: custo por entrega, tempo medio de entrega, e taxa de",
        "entregas no prazo. A meta e reduzir o tempo medio de 48h para 24h no primeiro ano.",
    ]);
}

export async function seed({
    base = "http://127.0.0.1:5000",
    username = "gladstone",
    password = "senha123",
    voice = "coral",
    questionCount = 3,
    template = "Teacher Assistant.yaml",
    label = "Teste Automatico de Audio",
    log = console.log,
} = {}) {
    const jar = makeJar();

    // 1. Login.
    const loginRes = await jfetch(base, jar, "/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
    });
    await expectJson(loginRes, "login");
    log(`  [seed] login ok (${username})`);

    // 2. Cria o trabalho.
    const workRes = await jfetch(base, jar, "/admin/works", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // sanitizeLabel proíbe < > : " / \ | ? * — timestamp só com dígitos e hífen.
        // kind EXPLÍCITO: na main o default de /admin/works virou "scenario" (cenários);
        // este harness testa a ENTREVISTA (student.html, upload em #file), então força interview.
        body: JSON.stringify({ name: `E2E Audio ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`, kind: "interview" }),
    });
    const { work } = await expectJson(workRes, "create work");
    const workToken = work.work_token;
    log(`  [seed] work criado token=${workToken}`);

    // 3. Sobe o enunciado (PDF).
    {
        const fd = new FormData();
        fd.append("file", new Blob([enunciadoPdf()], { type: "application/pdf" }), "enunciado.pdf");
        const res = await jfetch(base, jar, `/w/${workToken}/enunciado`, { method: "POST", body: fd });
        await expectJson(res, "upload enunciado");
        log("  [seed] enunciado enviado");
    }

    // 4. Salva o YAML do entrevistador a partir de um template pronto.
    {
        const tplRes = await jfetch(base, jar, `/interviewers/templates/${encodeURIComponent(template)}`);
        if (!tplRes.ok) throw new Error(`template ${template}: HTTP ${tplRes.status}`);
        const yamlText = await tplRes.text();
        const res = await jfetch(base, jar, `/w/${workToken}/interviewer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ yaml: yamlText }),
        });
        await expectJson(res, "save interviewer");
        log(`  [seed] entrevistador salvo (template: ${template})`);
    }

    // 5. Número de perguntas (baixo, pra manter o teste curto e barato).
    {
        const res = await jfetch(base, jar, `/w/${workToken}/question-count`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question_count: questionCount }),
        });
        await expectJson(res, "question-count");
        log(`  [seed] question_count=${questionCount}`);
    }

    // 6. Liga o modo áudio + voz.
    {
        const res = await jfetch(base, jar, `/w/${workToken}/interaction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "audio", voice }),
        });
        await expectJson(res, "interaction mode");
        log(`  [seed] modo=audio voz=${voice}`);
    }

    // 7. Cria a submissão (token do aluno).
    let subToken;
    {
        const res = await jfetch(base, jar, `/w/${workToken}/submissions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label }),
        });
        const { submissions } = await expectJson(res, "create submission");
        subToken = submissions[0].submission_token;
        log(`  [seed] submissão criada token=${subToken}`);
    }

    return {
        jar,            // reusável pra consultar a conversa pelo lado do professor
        workToken,
        subToken,
        studentUrl: `${base}/s/${subToken}`,
        trabalhoPdf: trabalhoPdf(),
    };
}

// Modo REMOTO (ambiente de teste/prod): o trabalho JÁ existe e está configurado
// (enunciado + entrevistador + modo áudio). Não cria trabalho nem faz login —
// só cunha UMA submissão a partir do token do trabalho. O endpoint
// POST /w/:workToken/submissions não exige sessão (requireWorkToken só valida o
// token), então isso roda sem credenciais. Sem jar → sem consulta do lado do
// professor (o relatório fica só com o lado do aluno).
export async function seedRemote({
    base = "http://127.0.0.1:5000",
    workToken,
    label = "Teste E2E Audio remoto",
    log = console.log,
} = {}) {
    if (!workToken) throw new Error("seedRemote: --work <token> obrigatório");
    const jar = makeJar(); // vazio: POST /w/:token/submissions é público
    const res = await jfetch(base, jar, `/w/${workToken}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
    });
    const { submissions } = await expectJson(res, "create submission (remoto)");
    const subToken = submissions[0].submission_token;
    log(`  [seed-remoto] submissão criada token=${subToken} (work=${workToken}, sem login)`);
    return {
        jar: null, // sem login → pula o relatório do lado do professor
        workToken,
        subToken,
        studentUrl: `${base}/s/${subToken}`,
        trabalhoPdf: trabalhoPdf(),
    };
}

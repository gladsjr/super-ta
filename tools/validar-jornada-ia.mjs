// Valida a jornada funcional COM IA do ambiente montado por este workspace.
//
// Não é teste de produto: não julga a qualidade da entrevista. Verifica que a
// cadeia cognitiva responde de ponta a ponta — upload indexado na OpenAI,
// PrepBuilder (análise + plano) e turnos do orquestrador.
//
// Dois dos três harnesses `tests/text-e2e-*.mjs` do tronco dependem de PDFs num
// caminho absoluto da máquina do autor e não rodam em outra; o
// `text-e2e-sponsor-ancoragem.mjs` é portável. Este driver não os substitui —
// eles testam PRODUTO, ele testa AMBIENTE, com prova lida do banco: os três
// artefatos da prep mais a fase alcançada.
// Gera os PDFs reusando `textToPdfBuffer` do tronco, como aquele harness faz.
//
// **Consome créditos da API da OpenAI** — alguns centavos por execução.
//
// Uso, da raiz do workspace:
//     docker compose exec app node /ferramental/validar-jornada-ia.mjs
//
// Roda DENTRO do container porque depende de módulos do tronco
// (`lib/scenarios/testWorkGen.js` para gerar os PDFs, `pg` para a prova) e da
// chave que o Compose injeta. O ferramental do workspace é montado
// em /ferramental (só leitura) pelo docker-compose.yml.

import fs from "node:fs";
import { createRequire } from "node:module";

// Os módulos do TRONCO ficam em /app/node_modules. Este
// script vive em /ferramental (o `tools/` do workspace, montado só-leitura), e
// dali o resolvedor de ESM procuraria em /ferramental/node_modules, que não
// existe. `createRequire` ancorado em /app resolve no lugar certo, sem copiar
// arquivo nem duplicar dependência.
// ATENÇÃO: `testWorkGen.js` é ESM (o tronco declara `"type": "module"`), e
// `require()` de grafo ESM só funciona a partir do **Node 20.19**. A imagem usa
// a tag `node:20-bookworm-slim`, hoje acima disso. Fixando a imagem numa 20
// anterior, este script quebra na carga com ERR_REQUIRE_ESM.
const requireDoTronco = createRequire("/app/");

const BASE = process.env.E2E_BASE || "http://127.0.0.1:5099";
const DIR = process.env.JORNADA_DIR || "/app/tmp";

function log(passo, detalhe) {
    console.log(`  ${passo.padEnd(34)} ${detalhe}`);
}

// --- PDFs -----------------------------------------------------------------

// Reusa o gerador do TRONCO em vez de reimplementar: `lib/scenarios/testWorkGen.js`
// já expõe `textToPdfBuffer(title, text)`, usado pelo harness
// `tests/text-e2e-sponsor-ancoragem.mjs`. Reimplementar seria duplicata.
const { textToPdfBuffer } = requireDoTronco("/app/lib/scenarios/testWorkGen.js");

// Parágrafo separado por linha em branco, como o gerador do tronco espera.
const SEPARADOR = String.fromCharCode(10, 10);

async function gerarPdf(caminho, titulo, paragrafos) {
    const buf = await textToPdfBuffer(titulo, paragrafos.join(SEPARADOR));

    fs.writeFileSync(caminho, buf);
    return caminho;
}

const ENUNCIADO = [
    "Objetivo: avaliar a compreensão do aluno sobre cache de leitura em sistemas web.",
    "O aluno deve entregar um relatório curto explicando: (a) por que um cache de leitura reduz latência; (b) o que é taxa de acerto (hit rate) e como ela afeta o ganho; (c) o que acontece quando o dado no cache fica velho, e duas estratégias para lidar com isso; (d) um caso em que adicionar cache PIORA o sistema.",
    "Critério: o aluno precisa demonstrar entendimento do mecanismo, não apenas repetir definições. Espera-se que saiba justificar as escolhas e reconhecer os limites da técnica.",
];

const TRABALHO = [
    "Relatório: cache de leitura em sistemas web",
    "Um cache de leitura guarda em memória rápida o resultado de consultas caras, normalmente feitas ao banco de dados. A latência cai porque a leitura seguinte é servida da memória, sem atravessar a rede até o banco nem repetir o trabalho de consulta. O ganho não vem de o banco ser lento em si, mas de evitar repetir trabalho idêntico.",
    "A taxa de acerto é a fração das leituras atendidas pelo cache. Ela governa o ganho real: com 90% de acerto, apenas uma em dez leituras paga o custo completo, e a latência média fica perto da latência da memória. Com 20% de acerto, o ganho é pequeno e ainda se paga o custo de manter o cache. Por isso a taxa de acerto é o número que decide se vale a pena, não o tamanho do cache.",
    "Dado velho no cache é o problema central. Chamamos de invalidação o ato de remover ou atualizar a entrada quando a fonte muda. Duas estratégias: expiração por tempo (TTL), simples mas que aceita servir dado velho por um intervalo conhecido; e invalidação por evento, em que a escrita no banco derruba a entrada correspondente — mais precisa, porém exige que todo caminho de escrita saiba avisar o cache, e um caminho esquecido serve dado velho indefinidamente.",
    "Cache piora o sistema quando os dados quase nunca são lidos duas vezes. Numa carga em que cada consulta é única, a taxa de acerto tende a zero: paga-se memória, paga-se a latência de consultar o cache antes de ir ao banco, e não se ganha nada. Pior ainda em dados que mudam a cada escrita e são lidos logo depois, porque aí o custo de invalidação se soma sem que haja reuso. Nesses casos o cache é sobrecusto puro, e a decisão certa é não ter cache.",
];

// --- HTTP -----------------------------------------------------------------

let cookie = "";

async function req(metodo, caminho, { json, form } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let body;
    if (json) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(json);
    } else if (form) {
        body = form;
    }
    const r = await fetch(`${BASE}${caminho}`, { method: metodo, headers, body });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const texto = await r.text();
    let dados = null;
    try {
        dados = JSON.parse(texto);
    } catch {
        dados = texto.slice(0, 300);
    }
    return { status: r.status, dados };
}

function formComPdf(caminho, campo = "file") {
    const fd = new FormData();
    const buf = fs.readFileSync(caminho);
    fd.set(campo, new Blob([buf], { type: "application/pdf" }), caminho.split("/").pop());
    return fd;
}

// --- Jornada --------------------------------------------------------------

async function main() {
    fs.mkdirSync(DIR, { recursive: true });

    console.log("\nJORNADA FUNCIONAL COM IA — ambiente montado pelo SDLC\n");

    // Guarda antecipada. Sem ela o sintoma aparece cinco passos adiante e
    // confuso: a rota do enunciado devolve HTTP 200 mesmo quando o upload à
    // OpenAI falha por credencial (a falha só sai no log do servidor), e o
    // primeiro erro visível vira um 500 no /start.
    //
    // A causa mais comum não é chave ausente na máquina, e sim chave ausente
    // NO CONTAINER: o Compose herda o ambiente de quem o invoca, então subir o
    // serviço de um shell que não vê ORATIA_OPENAI_TOKEN injeta vazio sem avisar.
    const chave = process.env.OPENAI_API_KEY || "";
    if (!chave) {
        console.error("  FALHOU: o container está sem OPENAI_API_KEY.");
        console.error("");
        console.error("  O Compose injeta ORATIA_OPENAI_TOKEN do ambiente de quem o invoca.");
        console.error("  Shell aberto ANTES de a variável ser definida não a vê — e o");
        console.error("  container sobe com a chave vazia, em silêncio.");
        console.error("");
        console.error("  Recrie o serviço de um shell que a veja:");
        console.error("      docker compose up -d --force-recreate app");
        console.error("");
        console.error("  (O verificador de pré-requisitos NÃO pega isto: ele testa o HOST,");
        console.error("   e o host pode ter a variável enquanto o container está sem.)");
        process.exit(1);
    }
    log("0. chave no container", `presente (${chave.length} chars)`);

    const pEnun = await gerarPdf(`${DIR}/enunciado.pdf`, "Enunciado — Cache de leitura", ENUNCIADO);
    const pTrab = await gerarPdf(`${DIR}/trabalho.pdf`, "Relatório do aluno", TRABALHO);
    log("1. PDFs gerados", `${fs.statSync(pEnun).size} e ${fs.statSync(pTrab).size} bytes`);

    // Default alinhado com INITIAL_USERS do `.env.example` — e o admin global é
    // o PRIMEIRO da lista, não o chamado "admin". Override por variável para não
    // quebrar quando o colaborador muda a semente (ver matriz de propagação).
    const usuario = process.env.JORNADA_USER || "professor";
    const senha = process.env.JORNADA_PASS || "senha123";
    const login = await req("POST", "/login", { json: { username: usuario, password: senha } });
    if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${JSON.stringify(login.dados)}`);
    log("2. login", `${usuario} — HTTP ${login.status}`);

    const work = await req("POST", "/admin/works", {
        json: { name: "Validação SDLC — cache de leitura", kind: "interview" },
    });
    if (work.status !== 200) throw new Error(`criar trabalho: ${work.status} ${JSON.stringify(work.dados)}`);
    const workToken = work.dados.work.work_token;
    log("3. trabalho criado", `work_token ${workToken}`);

    const enun = await req("POST", `/w/${workToken}/enunciado`, { form: formComPdf(pEnun) });
    if (enun.status !== 200) throw new Error(`upload enunciado: ${enun.status} ${JSON.stringify(enun.dados)}`);
    // HTTP 200 aqui NÃO prova indexação: a rota responde 200 e registra a falha
    // só no log do servidor quando o upload à OpenAI é recusado. Quem prova é o
    // `vector_store_id` no banco, conferido no passo 11.
    log("4. enunciado enviado", `HTTP ${enun.status} (indexação se confirma no passo 11)`);

    // DESVIO DECLARADO do padrão do produto, e é deliberado deste validador.
    //
    // `lib/db/works.js#createWork` faz um UPDATE pós-insert dizendo que
    // "entrevista nasce SEMPRE por voz (áudio) com fiscalização por vídeo —
    // ambos FIXOS (o professor não configura mais isso)". Não é o default da
    // coluna, que segue `text` para os outros tipos de trabalho.
    //
    // Este validador força TEXTO porque seu objetivo é a cadeia cognitiva, não
    // a cadeia de voz: em texto ela roda sem STT, TTS nem gate de vídeo. Ou
    // seja, um resultado verde aqui NÃO valida a jornada por voz — para isso
    // existe a skill `testar-modo-audio` no tronco.

    const modo = await req("POST", `/w/${workToken}/interaction`, { json: { mode: "text" } });
    if (modo.status !== 200) throw new Error(`modo de interação: ${modo.status} ${JSON.stringify(modo.dados)}`);
    log("5. modo de interação", `texto (era ${modo.dados.interaction_mode === "text" ? "áudio" : "?"})`);

    // Modo Simples: o professor escolhe uma persona pronta, sem escrever YAML.
    // Aqui a mesma persona é enviada pela API, que é o que a tela faz por baixo.
    const personaYaml = fs.readFileSync("/app/config/interviewers/Teacher Assistant.yaml", "utf8");
    const persona = await req("POST", `/w/${workToken}/interviewer`, { json: { yaml: personaYaml } });
    if (persona.status !== 200) throw new Error(`configurar arguidor: ${persona.status} ${JSON.stringify(persona.dados)}`);
    log("6. arguidor configurado", `persona Teacher Assistant (${personaYaml.length} bytes)`);

    const sub = await req("POST", `/w/${workToken}/submissions`, {
        json: { label: "aluno-validacao", is_test: true, count: 1 },
    });
    if (sub.status !== 200) throw new Error(`criar submissão: ${sub.status} ${JSON.stringify(sub.dados)}`);
    const lista = sub.dados.submissions || sub.dados.rows || [];
    const subToken = (lista[0] || {}).submission_token || (lista[0] || {}).token;
    if (!subToken) throw new Error(`sem submission_token: ${JSON.stringify(sub.dados).slice(0, 300)}`);
    log("7. link de aluno", `submission_token ${subToken}`);


    const start = await req("POST", `/s/${subToken}/start`, { json: {} });
    if (start.status !== 200) throw new Error(`start: ${start.status} ${JSON.stringify(start.dados)}`);
    log("8. sessão iniciada", `HTTP ${start.status}`);

    const up = await req("POST", `/s/${subToken}/upload`, { form: formComPdf(pTrab) });
    if (up.status !== 200) throw new Error(`upload trabalho: ${up.status} ${JSON.stringify(up.dados)}`);
    // ATENÇÃO: HTTP 200 aqui NÃO prova que a prep rodou. `routes/interview.js`
    // chama `startInterviewPreparation(sess)` SEM await — o comentário do código
    // diz que ela "segue rodando em background, não bloqueia a resposta". Quem
    // aguarda a promessa é o primeiro beat do /chat, que devolve 500 se falhar.
    log("9. trabalho submetido", `HTTP ${up.status} (a prep roda em background — confirma no passo 11)`);

    // A introdução consome DOIS turnos do aluno antes de a fase virar
    // `interviewing`: a saudação volta na resposta do `/upload`, e então
    // `present_self` e `begin` (`routes/interview.js`) — o segundo já
    // transiciona. Turno respondido, portanto, não prova orquestrador. Cinco
    // falas dão margem; qualquer turno falho já interrompe e reprova.
    const falas = [
        "Bruno.",
        "Pode começar, estou pronto.",
        "O cache guarda em memória o resultado de consultas caras, então a leitura seguinte não precisa ir até o banco. O ganho vem de não repetir trabalho igual.",
        "A taxa de acerto é a fração das leituras que o cache atende. Ela é que decide o ganho: com noventa por cento de acerto só uma em dez leituras paga o custo cheio.",
        "Piora quando cada consulta é única, porque a taxa de acerto vai a zero e você paga memória e uma consulta a mais sem reusar nada.",
    ];

    // A prova é observada a CADA turno, e acumulada.
    //
    // Motivo: com `question_count` default 6, o piso de finalização é
    // `⌈6/2⌉ = 3` respostas substantivas — exatamente o que estas falas dão. Se
    // o orquestrador finalizar, o handler restaura o invariante e zera
    // `runtime_state_json` e `current_phase` (`lib/db/submissions.js`). Uma
    // consulta única no fim leria tudo nulo e reprovaria uma execução que
    // funcionou, imprimindo causas falsas.
    const { Pool } = requireDoTronco("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    const visto = { plano: false, analise: false, vs: false, interviewing: false };
    let finalizou = false;

    async function observar() {
        const r = await pool.query(
            `SELECT current_phase, completed_at,
                    jsonb_typeof(runtime_state_json -> 'interview_plan') NOT IN ('null') AS plano,
                    jsonb_typeof(runtime_state_json -> 'super_orchestrator' -> 'work_analysis') NOT IN ('null') AS analise,
                    jsonb_typeof(runtime_state_json -> 'vector_store_id') NOT IN ('null') AS vs
               FROM submissions WHERE submission_token = $1`,
            [subToken]
        );
        const row = r.rows[0] || {};
        if (row.plano === true) visto.plano = true;
        if (row.analise === true) visto.analise = true;
        if (row.vs === true) visto.vs = true;
        if (row.current_phase === "interviewing") visto.interviewing = true;
        if (row.completed_at) finalizou = true;
    }

    let turnos = 0;
    let falhou = null;
    try {
        for (const fala of falas) {
            const fd = new FormData();
            fd.set("message", fala);
            const chat = await req("POST", `/s/${subToken}/chat`, { form: fd });
            if (chat.status !== 200) {
                // HTTP 410 depois de a entrevista ter finalizado NÃO é falha: é
                // `requireNotFinalized` recusando fala em sessão encerrada, o
                // comportamento correto. Isso acontece de verdade — o piso de
                // finalização é `⌈perguntas do PLANO / 2⌉`, e o PrepBuilder pode
                // devolver menos de seis perguntas, baixando o piso a ponto de o
                // orquestrador encerrar antes da última fala. Tratar como falha
                // produziria reprovação com causa inventada.
                await observar();
                if (chat.status === 410 && finalizou) {
                    log(`10.${turnos + 1} turno recusado`, "HTTP 410 — a entrevista já finalizou (encerramento legítimo)");
                    break;
                }
                falhou = `turno ${turnos + 1}: HTTP ${chat.status} — ${JSON.stringify(chat.dados).slice(0, 200)}`;
                log(`10.${turnos + 1} turno FALHOU`, falhou);
                break;
            }
            turnos++;
            await observar();
            const resp = chat.dados?.reply || chat.dados?.message || chat.dados?.assistant || "";
            log(`10.${turnos} turno respondido`, `"${String(resp).slice(0, 72).replace(/\s+/g, " ")}…"`);
        }
    } finally {
        await pool.end();
    }

    log("11. prep observada", `plano=${visto.plano ? "sim" : "NÃO"}  análise=${visto.analise ? "sim" : "NÃO"}  vector store=${visto.vs ? "sim" : "NÃO"}`);
    log("12. fase alcançada", `${visto.interviewing ? "interviewing — orquestrador exercitado" : "NUNCA chegou a interviewing"}${finalizou ? " (e a entrevista finalizou)" : ""}`);

    console.log("");
    const ok = !falhou && visto.plano && visto.analise && visto.vs && visto.interviewing;
    if (ok) {
        console.log(`  APROVADO: ${turnos} turnos; plano, análise e vector store observados; fase interviewing alcançada.`);
        if (finalizou) console.log("  (a entrevista chegou a finalizar — o estado foi zerado depois, o que é o comportamento correto)");
    } else {
        console.log("  REPROVADO:");
        if (falhou) console.log(`    · ${falhou}`);
        if (!visto.vs) console.log("    · vector store nunca observado: os PDFs não foram indexados na OpenAI");
        if (!visto.analise) console.log("    · work_analysis nunca observado: o PrepBuilder não concluiu a análise");
        if (!visto.plano) console.log("    · interview_plan nunca observado: o PrepBuilder não concluiu o plano");
        if (!visto.interviewing) console.log("    · a fase nunca chegou a interviewing — o orquestrador não foi exercitado");
    }
    console.log(`  work_token=${workToken}  submission_token=${subToken}`);
    console.log("");
    if (!ok) process.exit(1);
}

main().catch((e) => {
    console.error(`\n  FALHOU: ${e.message}\n`);
    process.exit(1);
});

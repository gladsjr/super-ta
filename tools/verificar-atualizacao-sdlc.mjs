#!/usr/bin/env node
// Verifica se o ferramental de SDLC tem atualização no remoto e, podendo,
// aplica-a. Roda automaticamente no início de cada sessão, pelo hook
// `SessionStart` declarado em `.claude/settings.json`.
//
// Objetivo: um colaborador nunca trabalha com um SDLC velho sem saber. O que
// este script traz — primer, skills, hooks — são instruções que o agente
// obedece, então ele é deliberadamente conservador:
//
//   árvore limpa + avanço fast-forward → aplica e resume o que mudou
//   árvore suja ou histórico divergente → avisa e NÃO toca em nada
//   sem rede, sem remoto, erro qualquer → avisa e segue
//
// NUNCA falha a sessão: sai sempre com 0. Uma falha de rede não pode impedir
// alguém de trabalhar.
//
// Só consulta o remoto se a última verificação passou de 24h — do contrário
// sai em silêncio, para não custar nada nas sessões seguintes do mesmo dia.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRANCH = "oratia-sdlc";
const INTERVALO_MS = 24 * 60 * 60 * 1000;
const ARQUIVO_ESTADO = ".sdlc-ultima-verificacao";

// Orçamento de tempo.
//
// INVARIANTE, com a folga que o pior caso exige:
//
//     timeout_do_hook_ms >= DEADLINE_TOTAL_MS + FOLGA_PISO_MS
//     hoje: 45_000 >= 25_000 + 10_000  ✓
//
// A desigualdade simples `DEADLINE < timeout` NÃO basta, e é fácil errar aqui.
// Cada chamada recebe `Math.max(PISO, ...)`: esgotado o deadline, as chamadas
// restantes ainda consomem o piso cada uma. FOLGA_PISO_MS cobre esse rabo.
//
// A direção da dependência: o timeout do hook é LIMITE SUPERIOR que este script
// tem de respeitar — estourá-lo mata o processo no meio e nem o aviso sai. O
// número que cede é o daqui. Mudou um dos dois, confira o outro; a matriz de
// propagação em `oratia-ambiente` registra o par, a direção e a folga.
const DEADLINE_TOTAL_MS = 25_000;
const FOLGA_PISO_MS = 10_000;
const PISO_POR_CHAMADA_MS = 1_000;
const TIMEOUT_REDE_MS = 12_000;
const TIMEOUT_LOCAL_MS = 5_000;

const INICIO = Date.now();
const restante = () => DEADLINE_TOTAL_MS - (Date.now() - INICIO);

// Ponto de desistência real. Encolher os prazos não basta: com o piso de 1s por
// chamada, uma sequência de operações lentas ultrapassaria o deadline mesmo
// assim. Antes de cada operação cara o script pergunta se ainda cabe, e sai
// avisando em vez de ser morto no meio pelo hook.
function semTempo(margemMs) {
    return restante() < margemMs;
}

// Caminhos cujo conteúdo o agente LÊ COMO INSTRUÇÃO. Mudança aqui altera o
// comportamento do agente, e por isso é destacada separadamente de mudança em
// documentação.
// Esta lista é a FONTE do que conta como instrução; o PRIMER a descreve em
// prosa e precisa acompanhá-la. Inclui o manifesto porque ele é base normativa
// declarada, não documentação de apoio.
const CAMINHOS_DE_INSTRUCAO = [
    "PRIMER.md",
    "CLAUDE.md",
    "METAS.md",
    "MANIFESTO.yaml",
    ".claude/skills/",
    ".claude/agents/",
    ".claude/settings.json",
    "tools/",
];

// ---------------------------------------------------------------------------

function acharRaiz() {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 20; i++) {
        if (existsSync(join(dir, "MANIFESTO.yaml"))) return dir;
        const pai = dirname(dir);
        if (pai === dir) return null;
        dir = pai;
    }
    return null;
}

// Chama o git capturando saída e sem deixar exceção escapar. Todo o script
// depende de nenhuma falha derrubar a sessão.
function git(raiz, args, timeout = TIMEOUT_LOCAL_MS) {
    // Nunca espera além do que sobra do deadline: melhor devolver falha e
    // imprimir o aviso do que ser morto pelo hook no meio da operação.
    const limite = Math.max(PISO_POR_CHAMADA_MS, Math.min(timeout, restante()));
    try {
        const saida = execFileSync("git", args, {
            cwd: raiz,
            encoding: "utf8",
            timeout: limite,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        return { ok: true, saida: String(saida).trim() };
    } catch (err) {
        const detalhe = [err.stderr, err.stdout].filter(Boolean).join(" ").trim();
        return { ok: false, saida: detalhe || err.message || "falha ao executar git" };
    }
}

function verificouRecentemente(caminhoEstado) {
    if (!existsSync(caminhoEstado)) return false;
    try {
        const marca = Number(readFileSync(caminhoEstado, "utf8").trim());
        if (!Number.isFinite(marca)) return false;
        return Date.now() - marca < INTERVALO_MS;
    } catch {
        return false;
    }
}

function registrarVerificacao(caminhoEstado) {
    try {
        writeFileSync(caminhoEstado, String(Date.now()), "utf8");
    } catch {
        // Não poder gravar a marca significa apenas verificar de novo na
        // próxima sessão. Não é motivo para interromper nada.
    }
}

// Separa os arquivos alterados entre os que o agente obedece e o resto.
function classificar(arquivos) {
    const instrucoes = arquivos.filter((f) =>
        CAMINHOS_DE_INSTRUCAO.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p))
    );
    return { instrucoes, outros: arquivos.filter((f) => !instrucoes.includes(f)) };
}

function relatarMudancas(raiz, de, para) {
    const arquivos = git(raiz, ["diff", "--name-only", `${de}..${para}`]);
    const assuntos = git(raiz, ["log", "--format=%s", `${de}..${para}`]);
    const linhas = [];

    const lista = arquivos.ok && arquivos.saida ? arquivos.saida.split("\n").filter(Boolean) : [];
    const { instrucoes, outros } = classificar(lista);

    if (assuntos.ok && assuntos.saida) {
        const s = assuntos.saida.split("\n").filter(Boolean);
        linhas.push(`  ${s.length} commit(s):`);
        for (const a of s.slice(0, 5)) linhas.push(`    · ${a}`);
        if (s.length > 5) linhas.push(`    · … e mais ${s.length - 5}`);
    }

    if (instrucoes.length > 0) {
        linhas.push("");
        linhas.push("  ATENÇÃO — mudou o que o agente lê como INSTRUÇÃO:");
        for (const f of instrucoes) linhas.push(`    ! ${f}`);
        linhas.push("  Releia estes arquivos antes de agir com base no que você lembra deles.");
    }
    if (outros.length > 0) {
        linhas.push(`  outros arquivos: ${outros.length}`);
    }
    return linhas;
}

// ---------------------------------------------------------------------------

function main() {
    const raiz = acharRaiz();
    if (!raiz) return; // fora do workspace: nada a fazer, em silêncio

    const caminhoEstado = join(raiz, ARQUIVO_ESTADO);
    if (verificouRecentemente(caminhoEstado)) return; // silêncio deliberado

    // Só age na branch do ferramental. Numa branch de trabalho do próprio
    // workspace, avisar seria ruído.
    const atual = git(raiz, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!atual.ok || atual.saida !== BRANCH) return;

    if (semTempo(TIMEOUT_REDE_MS)) {
        // Silêncio aqui seria lido como "em dia" — é o que significa no resto
        // do script. Sem orçamento nem para consultar, diga isso.
        console.log("[SDLC] Sem tempo no orçamento do hook para consultar o remoto; a verificação não rodou.");
        console.log("[SDLC] Rode `git pull --ff-only` na raiz do workspace quando puder.");
        return;
    }

    const fetch = git(raiz, ["fetch", "--quiet", "origin", BRANCH], TIMEOUT_REDE_MS);
    if (!fetch.ok) {
        // Offline, sem credencial, remoto fora do ar: informa e sai. Não
        // registra a marca — na próxima sessão tenta de novo.
        console.log(`[SDLC] Não deu para consultar o remoto: ${fetch.saida.split("\n")[0]}`);
        console.log("[SDLC] Seguindo com o ferramental local. Rode `git pull` quando houver rede.");
        return;
    }

    const local = git(raiz, ["rev-parse", "HEAD"]);
    const remoto = git(raiz, ["rev-parse", "FETCH_HEAD"]);
    if (!local.ok || !remoto.ok) return; // sem saber comparar, não marca nada

    // A marca de 24h só é gravada quando o desfecho é ESTÁVEL: já em dia, ou
    // atualizado com sucesso. Ficando PENDENTE (árvore suja, histórico
    // divergente, merge falho), ela NÃO é gravada — do contrário a próxima
    // sessão sairia em silêncio na checagem de 24h, e silêncio aqui significa
    // "em dia". Quem tivesse uma alteração local por alguns dias receberia o
    // aviso uma vez e depois trabalharia com instruções velhas sem sinal algum.
    if (local.saida === remoto.saida) {
        registrarVerificacao(caminhoEstado);
        return; // em dia: silêncio
    }

    // Há diferença. Só avança se for avanço puro: o remoto contém o local.
    const ehFastForward = git(raiz, ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]).ok;

    if (!ehFastForward) {
        console.log("[SDLC] O ferramental remoto DIVERGIU do local — históricos separados.");
        console.log("[SDLC] Nada foi alterado. Resolva manualmente antes de confiar no que está em disco.");
        return; // pendente: sem marca, avisa de novo na próxima sessão
    }

    // Daqui em diante vem o merge, que é a operação que não pode ser
    // interrompida no meio. Não cabendo no que resta do orçamento, avisa e sai
    // sem tocar em nada — a marca não é gravada, então a próxima sessão tenta
    // de novo.
    if (semTempo(TIMEOUT_REDE_MS)) {
        console.log("[SDLC] Há atualização do ferramental, mas o tempo do hook acabou antes de aplicá-la.");
        console.log("[SDLC] Nada foi alterado. Rode `git pull --ff-only` na raiz do workspace.");
        return;
    }

    // `--untracked-files=no` é essencial, não economia: arquivo não rastreado
    // não impede um fast-forward, e considerá-lo sujeira travaria a
    // atualização para sempre por causa de qualquer resíduo na raiz — o
    // `cookie.txt` que o próprio roteiro de validação cria, por exemplo.
    // No caso raro em que um arquivo novo do remoto colidiria com um não
    // rastreado, o `merge --ff-only` falha e o tratamento abaixo cobre.
    const status = git(raiz, ["status", "--porcelain", "--untracked-files=no"]);
    if (!status.ok) {
        // Falha ao consultar o estado não é o mesmo que árvore suja: dizer
        // "há alterações não commitadas" mandaria o colaborador procurar o que
        // não existe.
        console.log(`[SDLC] Há atualização do ferramental, mas não deu para conferir o estado local: ${status.saida.split("\n")[0]}`);
        console.log("[SDLC] Nada foi alterado.");
        return;
    }

    if (status.saida !== "") {
        console.log("[SDLC] Há atualização do ferramental, mas a árvore local tem alterações não commitadas.");
        console.log("[SDLC] Nada foi alterado. Commite ou guarde seu trabalho e rode `git pull --ff-only`.");
        for (const l of relatarMudancas(raiz, "HEAD", "FETCH_HEAD")) console.log(`[SDLC] ${l}`);
        return; // pendente: sem marca
    }

    const antes = local.saida;
    const pull = git(raiz, ["merge", "--ff-only", "FETCH_HEAD"], TIMEOUT_REDE_MS);
    if (!pull.ok) {
        console.log(`[SDLC] A atualização falhou: ${pull.saida.split("\n")[0]}`);
        console.log("[SDLC] Nada foi alterado.");
        return; // pendente: sem marca
    }

    registrarVerificacao(caminhoEstado); // desfecho estável
    console.log("[SDLC] Ferramental de SDLC atualizado a partir do remoto.");
    for (const l of relatarMudancas(raiz, antes, "HEAD")) console.log(`[SDLC] ${l}`);

    // Subagente e configuração de hook não entram em vigor no instante em que
    // o arquivo chega: a sessão os descobre com atraso, e o hook desta sessão
    // já rodou. Avisar evita que se conte com eles agora.
    const mudou = git(raiz, ["diff", "--name-only", `${antes}..HEAD`]).saida || "";
    if (/^\.claude\/(agents|settings\.json)/m.test(mudou)) {
        console.log("[SDLC] Mudou subagente ou configuração de hook: o subagente pode levar algum tempo até ficar disponível, e um hook de SessionStart só roda na próxima sessão.");
    }
}

try {
    main();
} catch (err) {
    // Rede de segurança final: nenhuma falha aqui pode impedir a sessão.
    console.log(`[SDLC] Verificação de atualização falhou: ${err?.message || err}`);
}
process.exit(0);

#!/usr/bin/env node
// Verifica os pré-requisitos declarados em MANIFESTO.yaml.
//
//   node tools/verificar-prerequisitos.mjs
//
// Saída: uma linha por item — OK, FALTA ou AVISO. Cada pendência vem com a
// ação que a resolve. O código de saída é 1 se houver qualquer BLOQUEIO, e 0
// caso contrário (avisos não reprovam).
//
// A lista de checagens NÃO vive aqui: vive no manifesto. Este script é só o
// executor, para que a lista tenha uma fonte da verdade só.
//
// Sem dependências, de propósito: esta branch não é um projeto npm e não deve
// ganhar node_modules. Roda com Node puro em Windows, macOS e Linux.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

// ---------------------------------------------------------------------------
// Raiz do workspace
// ---------------------------------------------------------------------------

// Sobe a partir deste arquivo até achar o manifesto. Assim o script funciona
// chamado de qualquer subdiretório, e não depende de onde o workspace foi
// clonado nem de como a pasta se chama.
function acharRaiz() {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 20; i++) {
        if (existsSync(join(dir, "MANIFESTO.yaml"))) return dir;
        const pai = dirname(dir);
        if (pai === dir) break; // chegou na raiz do sistema de arquivos
        dir = pai;
    }
    console.error("✗ MANIFESTO.yaml não encontrado subindo a partir de tools/.");
    console.error("  Este script precisa viver dentro do workspace, ao lado do manifesto.");
    process.exit(2);
}

// Raiz resolvida uma vez, no carregamento. Serve de diretório de trabalho para
// TODO comando de teste: sem isso o resultado dependeria de onde o script foi
// chamado, e um `teste:` que fale de `origin` examinaria o remote do clone do
// tronco quando invocado de dentro dele. Isto cumpre o que o comentário de
// `acharRaiz` promete acima, e não é checagem nova: a lista continua vindo só
// do manifesto.
const RAIZ = acharRaiz();

// ---------------------------------------------------------------------------
// Parser de YAML — subconjunto restrito ao que o manifesto usa
// ---------------------------------------------------------------------------
//
// Suporta: mapas aninhados, listas de escalares, listas de mapas, escalares de
// uma linha (string, número, booleano), aspas simples e duplas, e comentários.
//
// NÃO suporta: blocos multi-linha (| e >), âncoras, tags, fluxo inline
// ({} e []). O manifesto é escrito dentro desse subconjunto de propósito —
// se precisar de mais, prefira reescrever o manifesto a ampliar este parser.

function tokenizar(texto) {
    const linhas = [];
    for (const bruta of texto.split(/\r?\n/)) {
        const semComentario = removerComentario(bruta);
        if (semComentario.trim() === "") continue;
        const indent = semComentario.length - semComentario.trimStart().length;
        let conteudo = semComentario.trim();
        const ehItem = conteudo === "-" || conteudo.startsWith("- ");
        if (ehItem) conteudo = conteudo.replace(/^-\s*/, "");
        linhas.push({ indent, conteudo, ehItem });
    }
    return linhas;
}

// Remove o comentário respeitando aspas: um `#` dentro de string é conteúdo.
function removerComentario(linha) {
    let dentro = null;
    for (let i = 0; i < linha.length; i++) {
        const c = linha[i];
        if (dentro) {
            if (c === dentro) dentro = null;
        } else if (c === '"' || c === "'") {
            dentro = c;
        } else if (c === "#" && (i === 0 || /\s/.test(linha[i - 1]))) {
            return linha.slice(0, i);
        }
    }
    return linha;
}

function escalar(bruto) {
    const v = bruto.trim();
    if (v === "") return null;
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
        (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
        return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null" || v === "~") return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d*\.\d+$/.test(v)) return Number(v);
    return v;
}

// Divide `chave: valor` no primeiro `:` que estiver fora de aspas.
function dividirChave(conteudo) {
    let dentro = null;
    for (let i = 0; i < conteudo.length; i++) {
        const c = conteudo[i];
        if (dentro) {
            if (c === dentro) dentro = null;
        } else if (c === '"' || c === "'") {
            dentro = c;
        } else if (c === ":" && (i + 1 === conteudo.length || /\s/.test(conteudo[i + 1]))) {
            return [conteudo.slice(0, i).trim(), conteudo.slice(i + 1).trim()];
        }
    }
    return null;
}

function parseBloco(linhas, inicio, indent) {
    if (inicio >= linhas.length) return [null, inicio];
    return linhas[inicio].ehItem
        ? parseLista(linhas, inicio, indent)
        : parseMapa(linhas, inicio, indent);
}

function parseLista(linhas, i, indent) {
    const saida = [];
    while (i < linhas.length && linhas[i].indent === indent && linhas[i].ehItem) {
        const l = linhas[i];
        const par = dividirChave(l.conteudo);
        if (par === null) {
            // Item escalar simples: `- valor`
            saida.push(escalar(l.conteudo));
            i++;
            continue;
        }
        // Item que é um mapa. A primeira chave vem na linha do `-`; as demais
        // vêm indentadas abaixo. Reconstruo o bloco com a primeira chave
        // realinhada, para que o parser de mapa as veja no mesmo nível.
        const indentInterno = indent + 2;
        const bloco = [{ indent: indentInterno, conteudo: l.conteudo, ehItem: false }];
        let j = i + 1;
        while (j < linhas.length && linhas[j].indent > indent) {
            bloco.push({ ...linhas[j], indent: linhas[j].indent });
            j++;
        }
        // Realinha o bloco para o indent interno, preservando os degraus relativos.
        const menor = Math.min(...bloco.slice(1).map((b) => b.indent), indentInterno);
        const ajuste = indentInterno - menor;
        const normalizado = bloco.map((b, idx) =>
            idx === 0 ? b : { ...b, indent: b.indent + ajuste }
        );
        const [valor] = parseBloco(normalizado, 0, indentInterno);
        saida.push(valor);
        i = j;
    }
    return [saida, i];
}

function parseMapa(linhas, i, indent) {
    const saida = {};
    while (i < linhas.length && linhas[i].indent === indent && !linhas[i].ehItem) {
        const par = dividirChave(linhas[i].conteudo);
        if (par === null) break;
        const [chave, valorBruto] = par;
        if (valorBruto !== "") {
            saida[chave] = escalar(valorBruto);
            i++;
            continue;
        }
        // Valor vazio: o conteúdo está no bloco indentado abaixo.
        if (i + 1 < linhas.length && linhas[i + 1].indent > indent) {
            const [valor, prox] = parseBloco(linhas, i + 1, linhas[i + 1].indent);
            saida[chave] = valor;
            i = prox;
        } else {
            saida[chave] = null;
            i++;
        }
    }
    return [saida, i];
}

function parseYaml(texto) {
    const linhas = tokenizar(texto);
    if (linhas.length === 0) return {};
    const [valor] = parseBloco(linhas, 0, linhas[0].indent);
    return valor;
}

// ---------------------------------------------------------------------------
// Execução dos testes
// ---------------------------------------------------------------------------

function rodar(comando) {
    try {
        const saida = execSync(comando, {
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            cwd: RAIZ,
            timeout: 30_000,
            windowsHide: true,
        });
        return { ok: true, saida: String(saida).trim() };
    } catch (err) {
        const detalhe = [err.stdout, err.stderr].filter(Boolean).join(" ").trim();
        return { ok: false, saida: detalhe || err.message };
    }
}

function extrairVersao(texto) {
    const m = String(texto).match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versaoSuficiente(encontrada, minima) {
    const a = extrairVersao(encontrada);
    const b = extrairVersao(minima);
    if (!a || !b) return null; // não deu para comparar
    for (let i = 0; i < 3; i++) {
        if (a[i] > b[i]) return true;
        if (a[i] < b[i]) return false;
    }
    return true;
}

// Duas checagens, porque nenhuma sozinha basta.
//
// O idioma comum — tentar `listen` e olhar EADDRINUSE — dá FALSO NEGATIVO no
// Windows com Docker Desktop: verificado nesta máquina que, com a aplicação
// publicada e respondendo na 5099, o bind sucede tanto em 127.0.0.1 quanto em
// 0.0.0.0. O Docker publica por um proxy que não disputa o bind com o host.
//
// Então: primeiro tenta CONECTAR (pega qualquer coisa que já esteja atendendo,
// container inclusive) e, se ninguém atender, tenta o bind (pega a porta que
// está reservada por um processo que não aceita conexão).
function conexaoAceita(porta) {
    return new Promise((resolve) => {
        const s = net.connect({ port: porta, host: "127.0.0.1" });
        const fim = (r) => {
            s.destroy();
            resolve(r);
        };
        s.setTimeout(1500);
        s.once("connect", () => fim(true));
        s.once("timeout", () => fim(false));
        s.once("error", () => fim(false));
    });
}

function bindAceito(porta) {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once("error", (e) => resolve(e.code !== "EADDRINUSE"));
        s.once("listening", () => s.close(() => resolve(true)));
        s.listen(porta, "0.0.0.0");
    });
}

async function portaLivre(porta) {
    if (await conexaoAceita(porta)) return false; // já tem alguém atendendo
    return await bindAceito(porta);
}

// A porta ocupada pela PRÓPRIA aplicação não é problema — é o ambiente já de
// pé. Distinguir evita que rodar o verificador com tudo funcionando reporte
// uma pendência que não existe.
async function ehAPropriaApp(porta) {
    try {
        const r = await fetch(`http://127.0.0.1:${porta}/oral/ping`, {
            signal: AbortSignal.timeout(2000),
        });
        return r.ok && (await r.text()).trim() === "ok";
    } catch {
        return false;
    }
}

// Lê o .env do workspace sem dependência externa. Só o suficiente para saber
// se uma variável está DECLARADA e com valor — o conteúdo nunca é impresso.
function lerDotenv(raiz) {
    const caminho = join(raiz, ".env");
    if (!existsSync(caminho)) return {};
    const mapa = {};
    for (const linha of readFileSync(caminho, "utf8").split(/\r?\n/)) {
        const t = linha.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        mapa[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return mapa;
}

async function verificar(pre, raiz, dotenv) {
    // Arquivos que precisam existir.
    if (Array.isArray(pre.teste_arquivos)) {
        const faltando = pre.teste_arquivos.filter((f) => !existsSync(resolve(raiz, f)));
        return faltando.length === 0
            ? { estado: "ok", detalhe: `${pre.teste_arquivos.length} arquivo(s) presente(s)` }
            : { estado: "falta", detalhe: `não encontrado: ${faltando.join(", ")}` };
    }

    // Porta livre no host.
    if (pre.teste_porta_env) {
        const porta = Number(
            process.env[pre.teste_porta_env] || dotenv[pre.teste_porta_env] || pre.porta_padrao
        );
        if (!Number.isFinite(porta)) {
            return { estado: "falta", detalhe: `valor de ${pre.teste_porta_env} não é um número` };
        }
        if (await portaLivre(porta)) {
            return { estado: "ok", detalhe: `porta ${porta} livre` };
        }
        if (await ehAPropriaApp(porta)) {
            return { estado: "ok", detalhe: `porta ${porta} ocupada pela própria aplicação, que já está no ar` };
        }
        return { estado: "falta", detalhe: `porta ${porta} ocupada por outro processo` };
    }

    // Variável de ambiente ou linha do .env — só a PRESENÇA, nunca o valor.
    if (pre.teste_env_ou_dotenv) {
        const nome = pre.teste_env_ou_dotenv;
        if (process.env[nome]) return { estado: "ok", detalhe: `${nome} definida no ambiente` };
        if (dotenv[nome]) return { estado: "ok", detalhe: `${nome} preenchida no .env` };
        return { estado: "falta", detalhe: `${nome} não está definida nem no ambiente nem no .env` };
    }

    // Comando que precisa retornar 0, opcionalmente com versão mínima ou com
    // um trecho esperado na saída.
    if (pre.teste) {
        const r = rodar(pre.teste);
        if (!r.ok) {
            const primeira = r.saida.split("\n")[0].slice(0, 120);
            return { estado: "falta", detalhe: primeira || `\`${pre.teste}\` falhou` };
        }
        if (pre.saida_contem) {
            return r.saida.includes(pre.saida_contem)
                ? { estado: "ok", detalhe: r.saida.split("\n")[0].slice(0, 80) }
                : {
                      estado: "falta",
                      detalhe: `esperado "${pre.saida_contem}" na saída, veio "${r.saida.split("\n")[0].slice(0, 60)}"`,
                  };
        }
        if (pre.versao_minima) {
            const suficiente = versaoSuficiente(r.saida, pre.versao_minima);
            if (suficiente === null) {
                return {
                    estado: "aviso",
                    detalhe: `versão não reconhecida na saída de \`${pre.teste}\` (mínima ${pre.versao_minima})`,
                };
            }
            if (!suficiente) {
                const achada = extrairVersao(r.saida).join(".");
                return { estado: "falta", detalhe: `versão ${achada}, mínima ${pre.versao_minima}` };
            }
            return { estado: "ok", detalhe: `versão ${extrairVersao(r.saida).join(".")}` };
        }
        // Sem versão mínima declarada: mostra a versão se a saída trouxer uma,
        // senão só confirma que respondeu. A primeira linha crua costuma ser
        // inútil como detalhe (`docker info` abre com "Client:").
        const v = extrairVersao(r.saida);
        return { estado: "ok", detalhe: v ? `versão ${v.join(".")}` : "disponível" };
    }

    return { estado: "aviso", detalhe: "pré-requisito sem teste declarado no manifesto" };
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

// Cor só quando a saída é um terminal de verdade: em arquivo ou pipe, os
// códigos ANSI virariam lixo.
const cor = process.stdout.isTTY
    ? { verde: "\x1b[32m", vermelho: "\x1b[31m", amarelo: "\x1b[33m", cinza: "\x1b[90m", forte: "\x1b[1m", zero: "\x1b[0m" }
    : { verde: "", vermelho: "", amarelo: "", cinza: "", forte: "", zero: "" };

async function main() {
    const raiz = RAIZ;
    const manifesto = parseYaml(readFileSync(join(raiz, "MANIFESTO.yaml"), "utf8"));
    const prerequisitos = manifesto?.prerequisitos;

    if (!Array.isArray(prerequisitos) || prerequisitos.length === 0) {
        console.error("✗ MANIFESTO.yaml não declara `prerequisitos` — nada a verificar.");
        process.exit(2);
    }

    const dotenv = lerDotenv(raiz);

    console.log(`${cor.forte}Pré-requisitos do ambiente — ${manifesto.workspace?.nome ?? "workspace"}${cor.zero}`);
    console.log(`${cor.cinza}raiz: ${raiz}${cor.zero}\n`);

    let bloqueios = 0;
    let avisos = 0;
    const pendencias = [];

    for (const pre of prerequisitos) {
        // Pré-requisito restrito a um sistema operacional (ex.: WSL2, que só
        // existe no Windows). Nos demais, some do relatório em vez de virar
        // ruído permanente.
        if (pre.aplica_se_so && pre.aplica_se_so !== process.platform) continue;

        const r = await verificar(pre, raiz, dotenv);
        // Um item de nível `aviso` nunca vira bloqueio, por mais que falhe.
        const estado = r.estado === "falta" && pre.nivel !== "bloqueio" ? "aviso" : r.estado;

        if (estado === "ok") {
            console.log(`  ${cor.verde}OK   ${cor.zero} ${pre.nome} ${cor.cinza}— ${r.detalhe}${cor.zero}`);
        } else if (estado === "falta") {
            bloqueios++;
            console.log(`  ${cor.vermelho}FALTA${cor.zero} ${pre.nome} ${cor.cinza}— ${r.detalhe}${cor.zero}`);
            pendencias.push({ tipo: "FALTA", pre, detalhe: r.detalhe });
        } else {
            avisos++;
            console.log(`  ${cor.amarelo}AVISO${cor.zero} ${pre.nome} ${cor.cinza}— ${r.detalhe}${cor.zero}`);
            pendencias.push({ tipo: "AVISO", pre, detalhe: r.detalhe });
        }
    }

    if (pendencias.length > 0) {
        console.log(`\n${cor.forte}Como resolver${cor.zero}`);
        for (const p of pendencias) {
            const marca = p.tipo === "FALTA" ? `${cor.vermelho}FALTA${cor.zero}` : `${cor.amarelo}AVISO${cor.zero}`;
            console.log(`\n  ${marca} ${cor.forte}${p.pre.nome}${cor.zero}`);
            if (p.pre.porque) console.log(`        por quê: ${p.pre.porque}`);
            if (p.pre.acao) console.log(`        ação:    ${p.pre.acao}`);
        }
    }

    console.log("");
    if (bloqueios > 0) {
        console.log(`${cor.vermelho}${cor.forte}${bloqueios} bloqueio(s)${cor.zero} e ${avisos} aviso(s). O ambiente NÃO sobe assim.`);
        process.exit(1);
    }
    if (avisos > 0) {
        console.log(`${cor.verde}Zero bloqueios${cor.zero}, ${cor.amarelo}${avisos} aviso(s)${cor.zero}. O ambiente sobe; alguma capacidade fica indisponível.`);
        process.exit(0);
    }
    console.log(`${cor.verde}${cor.forte}Zero bloqueios e zero avisos.${cor.zero} Ambiente pronto.`);
    process.exit(0);
}

main().catch((err) => {
    console.error(`✗ erro inesperado: ${err?.stack || err?.message || err}`);
    process.exit(2);
});

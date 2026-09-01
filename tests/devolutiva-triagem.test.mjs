// A triagem humana governa o que a devolutiva diz ao aluno (#361, ADR 0017).
//
// A prova oral montava a devolutiva sem consultar a triagem: mesmo depois de o
// professor assistir ao vídeo e marcar "sem problema", o alerta automático
// continuava indo ao aluno. Ele lia uma insinuação que um humano já havia
// examinado e descartado — o que desfaz o ato do professor e contraria a razão
// de a fiscalização existir (ADR 0004: indício para revisão humana, nunca
// acusação).
//
// A regra estava escrita duas vezes (entrevista e oral) e a segunda cópia
// esqueceu a metade que importa. Agora é uma função só, e é ela que estes
// testes exercitam.
//
//   node --test tests/devolutiva-triagem.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { composeProctorForDevolutiva, PROCTOR_REVIEW_DEFS } from "../lib/proctorReview.js";

// Relatório de fiscalização com um achado — o suficiente para
// renderProctorForStudent produzir texto.
const COM_ALERTA = {
    flags: { phone: { count: 40, count_sec: 40, pct: 40 } },
    frames: 300,
    video_duration_s: 300,
    covered_s: 300,
};

const contem = (txt, s) => typeof txt === "string" && txt.includes(s);

test("'sem problema' SUPRIME o alerta automático — o defeito da #361", () => {
    const saida = composeProctorForDevolutiva({ level: "sem_problema" }, COM_ALERTA);
    assert.equal(saida, null,
        "o professor revisou e descartou: nada de fiscalização pode chegar ao aluno");
});

test("'não revisado' deixa passar só o resumo automático", () => {
    const saida = composeProctorForDevolutiva({ level: "nao_revisado" }, COM_ALERTA);
    assert.ok(saida, "sem triagem, o comportamento anterior se mantém");
    assert.ok(!contem(saida, "TRIAGEM DO PROFESSOR"),
        "não há juízo humano a comunicar — inconclusivo não é achado");
});

test("'em aberto' não vira achado na devolutiva", () => {
    const saida = composeProctorForDevolutiva({ level: "em_aberto" }, COM_ALERTA);
    assert.ok(!contem(saida, "TRIAGEM DO PROFESSOR"),
        "dúvida do professor não pode ser comunicada como constatação (ADR 0004)");
});

test("'confirmado' leva o juízo do professor, em linguagem formativa", () => {
    for (const nivel of ["confirmado_leve", "confirmado_moderado", "confirmado_grave"]) {
        const saida = composeProctorForDevolutiva({ level: nivel, note: "usou o celular" }, COM_ALERTA);
        assert.ok(contem(saida, "TRIAGEM DO PROFESSOR"), `${nivel}: o juízo humano precisa entrar`);
        assert.ok(contem(saida, "usou o celular"), `${nivel}: a observação do professor precisa chegar`);
        assert.ok(contem(saida, "NÃO acuse"), `${nivel}: a instrução formativa precisa acompanhar`);
    }
});

test("sem relatório de vídeo, um 'confirmado' ainda comunica o juízo", () => {
    // O professor pode confirmar por ter assistido, mesmo sem achado automático.
    const saida = composeProctorForDevolutiva({ level: "confirmado_leve" }, null);
    assert.ok(contem(saida, "TRIAGEM DO PROFESSOR"));
});

test("sem triagem e sem relatório, não há bloco nenhum", () => {
    assert.equal(composeProctorForDevolutiva(null, null), null);
    assert.equal(composeProctorForDevolutiva({ level: "nao_revisado" }, null), null);
});

test("todo nível definido tem comportamento decidido", () => {
    // Guarda para quando um nível novo for acrescentado: ele passa por aqui e
    // alguém precisa decidir conscientemente se vai ao aluno ou não.
    for (const def of PROCTOR_REVIEW_DEFS) {
        const saida = composeProctorForDevolutiva({ level: def.key }, COM_ALERTA);
        const temJuizo = contem(saida, "TRIAGEM DO PROFESSOR");
        assert.equal(temJuizo, !!def.naDevolutiva,
            `${def.key}: naDevolutiva=${def.naDevolutiva} mas o bloco do professor ${temJuizo ? "entrou" : "não entrou"}`);
    }
});

test("a regra da devolutiva existe em UM lugar só", () => {
    // O defeito nasceu de duas cópias divergentes. Se alguém escrever de novo a
    // comparação com 'sem_problema' fora do proctorReview.js, a terceira
    // arguição repete o erro.
    const raiz = new URL("../lib", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const culpados = fs.readdirSync(raiz, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith(".js") && e.name !== "proctorReview.js")
        .map(e => e.name)
        // A COMPARAÇÃO, não a menção: os dois arquivos citam 'sem_problema' em
        // comentário para explicar a regra, e isso é desejável.
        .filter(f => /level\s*[!=]==\s*["']sem_problema["']/.test(fs.readFileSync(path.join(raiz, f), "utf8")));
    assert.deepEqual(culpados, [],
        `a regra do 'sem_problema' voltou a ser duplicada em: ${culpados.join(", ")} — use composeProctorForDevolutiva (#361)`);
});

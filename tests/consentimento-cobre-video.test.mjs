// O termo de consentimento tem de DECLARAR tudo o que se grava (#346).
//
// O defeito: `CONSENT_TEXT_HTML` — o termo da entrevista POR MENSAGENS — não
// mencionava câmera nem vídeo. Só que a entrevista por mensagens roda com
// fiscalização por vídeo (hoje fixa, ligada na configuração): a câmera abre,
// o vídeo é GRAVADO, e sem ele a sessão nem começa nem conclui (ADR 0005).
// Gravava-se, portanto, uma categoria de dado que o aluno nunca tinha visto
// declarada — e consentimento é invariante de privacidade do projeto.
//
// A correção é um adendo condicional (`CONSENT_VIDEO_ADDITION_HTML`), no
// mesmo padrão do adendo do modo áudio, concatenado só quando
// `proctoring_enabled` está ligado. Estes testes travam a regra: se alguém
// reescrever o termo e o vídeo sumir do texto, isto quebra.
//
//   node --test tests/consentimento-cobre-video.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
    CONSENT_VERSION,
    CONSENT_TEXT_HTML,
    CONSENT_AUDIO_ADDITION_HTML,
    CONSENT_VIDEO_ADDITION_HTML,
    CONSENT_ORAL_HTML,
    CONSENT_LIVE_HTML,
} from "../config/consent.js";

const raiz = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ler = (...x) => fs.readFileSync(path.join(raiz, ...x), "utf8");

const menciona = (html, re) => re.test(html);

test("todo termo que acompanha gravação de vídeo declara câmera E vídeo", () => {
    // Prova oral e entrevista simplificada: câmera fixa, declarada no corpo.
    for (const [nome, html] of [["oral", CONSENT_ORAL_HTML], ["live", CONSENT_LIVE_HTML]]) {
        assert.ok(menciona(html, /câmera/i), `${nome}: o termo não fala em câmera`);
        assert.ok(menciona(html, /vídeo/i), `${nome}: o termo não fala em vídeo`);
    }
    // Entrevista por mensagens: a câmera é por trabalho, então o vídeo vive no
    // ADENDO — é ele que precisa declarar.
    assert.ok(menciona(CONSENT_VIDEO_ADDITION_HTML, /câmera/i), "adendo de vídeo sem menção a câmera");
    assert.ok(menciona(CONSENT_VIDEO_ADDITION_HTML, /gravad|gravação/i), "adendo de vídeo sem menção à gravação");
});

test("o adendo de vídeo repete as garantias que os outros termos já dão", () => {
    // Não basta avisar que grava: retenção, restrição de acesso, ausência de
    // envio à OpenAI e o direito de exclusão são o que torna o aviso um termo.
    assert.ok(/6 meses/i.test(CONSENT_VIDEO_ADDITION_HTML), "sem prazo de retenção");
    assert.ok(/NÃO é enviado à OpenAI/i.test(CONSENT_VIDEO_ADDITION_HTML), "sem a garantia de que o vídeo não vai à OpenAI");
    assert.ok(/exclusão antecipada/i.test(CONSENT_VIDEO_ADDITION_HTML), "sem o direito de exclusão antecipada (LGPD)");
    // ADR 0004: a fiscalização não penaliza nem acusa. O aluno tem de ler isso.
    assert.ok(/não.{0,40}altera sua nota automaticamente/i.test(CONSENT_VIDEO_ADDITION_HTML),
        "sem a ressalva de que a fiscalização não mexe na nota sozinha (ADR 0004)");
});

test("os adendos são realmente adendos — não repetem o corpo do termo", () => {
    // Se o vídeo entrasse no corpo, apareceria para quem faz entrevista SEM
    // fiscalização, declarando uma coleta que não acontece. O erro simétrico.
    assert.ok(!menciona(CONSENT_TEXT_HTML, /câmera|vídeo/i),
        "o termo-base da entrevista por mensagens fala de vídeo — ele é mostrado também sem fiscalização");
    assert.ok(!menciona(CONSENT_AUDIO_ADDITION_HTML, /câmera|vídeo/i),
        "o adendo de ÁUDIO fala de vídeo — modo áudio e fiscalização são independentes");
});

test("a rota /api/consent entrega o adendo de vídeo ao navegador", () => {
    const rota = ler("routes", "static.js");
    assert.ok(/CONSENT_VIDEO_ADDITION_HTML/.test(rota), "routes/static.js não importa o adendo de vídeo");
    assert.ok(/videoAdditionHtml:\s*CONSENT_VIDEO_ADDITION_HTML/.test(rota),
        "/api/consent não expõe videoAdditionHtml — o modal do aluno nunca vê o bloco");
});

test("a tela do aluno concatena o adendo quando a fiscalização está ligada", () => {
    const tela = ler("static", "student.html");
    assert.ok(/proctoringEnabled \? \(consent\.videoAdditionHtml \|\| ''\) : ''/.test(tela),
        "student.html não condiciona o adendo de vídeo ao proctoring");
    assert.ok(/ensureConsent\(interactionMode, !!\(cfg && cfg\.proctoring_enabled\)\)/.test(tela),
        "student.html não passa o estado da fiscalização ao termo — o adendo nunca apareceria");
});

test("a versão do termo subiu junto com o texto", () => {
    // O arquivo manda incrementar a versão a cada mudança de texto: é a chave
    // do sessionStorage na entrevista por mensagens e o critério de `consent_ok`
    // nos fluxos de voz. Uma aba aberta desde antes do deploy só volta a ver o
    // termo se a versão mudar — que é exatamente o caso que abriu a lacuna.
    assert.notEqual(CONSENT_VERSION, "3.0.0",
        "o texto do termo mudou (#346) e CONSENT_VERSION continua na versão anterior");
});

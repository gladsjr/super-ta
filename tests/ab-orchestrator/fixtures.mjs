// Fixtures sintéticas para o teste A/B do super-orquestrador.
//
// Auto-contido: NÃO depende de PDFs reais. Geramos um "enunciado" (documento
// motivador, na voz do cliente) e um "trabalho do aluno" (estudo de viabilidade)
// como PDFs de texto via tests/audio-e2e/pdfgen.mjs.
//
// O trabalho contém DE PROPÓSITO números concretos e três contradições internas
// plantadas, mais uma lacuna de escopo. Isso dá material rico para o
// super-orquestrador exercitar perguntas, follow-ups e verificação de
// contradições — exatamente as dimensões que o A/B mede. As contradições:
//   (C1) taxa de desconto: 10% nas premissas (Sec.2) vs 14% na planilha (Tab.4).
//   (C2) escopo: o cliente pediu 3 cenários; o estudo entrega só 2.
//   (C3) recomendação vs dados: recomenda a Opção A, mas a Tab.5 mostra a
//        Opção B com VPL maior.
//   (L1) lacuna: o cliente pediu para considerar a troca do inversor; o estudo
//        não trata disso.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePdf } from "../audio-e2e/pdfgen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------
// Documento motivador (enunciado) — voz do cliente (camada A: fatos de negócio)
// --------------------------------------------------------------------------
const ENUNCIADO_PARAS = [
    "Briefing do cliente - Estudo de viabilidade de energia solar para o restaurante Maré Alta",
    "",
    "Sou o dono do restaurante Mare Alta. Contratei voce como consultor para avaliar se vale a pena instalar paineis solares no telhado do restaurante. Quero uma recomendacao clara o suficiente para eu decidir com seguranca.",
    "",
    "Contexto do negocio:",
    "- Tenho cerca de 40 kW de area de telhado disponivel para os paineis.",
    "- Minha conta de luz hoje gira em torno de 6.500 reais por mes.",
    "- Quero raciocinar num horizonte de 10 anos.",
    "- Minha referencia interna de retorno para decisoes assim e de 8% ao ano; abaixo disso eu prefiro deixar o dinheiro aplicado.",
    "",
    "O que eu preciso do estudo:",
    "- Quero ver tres cenarios: um otimista, um base e um pessimista, variando preco da energia e geracao.",
    "- Considere que inversores costumam precisar de troca antes dos 10 anos; quero saber se isso muda muito a conta.",
    "- Compare instalar um sistema menor com um sistema que ocupe todo o telhado disponivel.",
    "- Me diga, no fim, em que condicoes faz sentido seguir em frente e quais sao os riscos.",
    "",
    "Nao precisa de sofisticacao tecnica excessiva. Precisa ser defensavel e aderente ao meu caso concreto.",
];

// --------------------------------------------------------------------------
// Trabalho do aluno (estudo de viabilidade) — com contradições plantadas
// --------------------------------------------------------------------------
const TRABALHO_PARAS = [
    "Estudo de viabilidade economica - Sistema fotovoltaico para o restaurante Mare Alta",
    "Autor: consultoria do aluno",
    "",
    "1. Resumo executivo",
    "Avaliamos a instalacao de um sistema fotovoltaico para reduzir a conta de energia do restaurante Mare Alta. A recomendacao final e adotar a Opcao A (sistema de 30 kW), que apresenta bom equilibrio entre investimento e retorno dentro do horizonte de 10 anos.",
    "",
    "2. Premissas",
    "Adotamos uma taxa de desconto de 10% ao ano para trazer os fluxos a valor presente. A inflacao de energia foi estimada em 6% ao ano. A vida util do sistema considerada foi de 10 anos. O CAPEX da Opcao A (30 kW) foi estimado em R$ 180.000.",
    "",
    "3. Metodologia",
    "Construimos o fluxo de caixa anual da economia gerada e descontamos a valor presente para obter o VPL. Analisamos tres cenarios de sensibilidade variando o preco da energia e a geracao anual.",
    "",
    "4. Fluxo de caixa e VPL (Opcao A, 30 kW)",
    "A Tabela 4 traz o fluxo descontado. Para o desconto dos fluxos na Tabela 4 utilizamos a taxa de 14% ao ano. O VPL resultante no cenario base foi de R$ 85.000, com payback simples de aproximadamente 6 anos.",
    "",
    "5. Comparacao de alternativas",
    "A Tabela 5 compara a Opcao A (30 kW) com a Opcao B (40 kW). A Opcao A apresenta VPL de R$ 85.000. A Opcao B apresenta VPL de R$ 102.000 e payback de 6,5 anos. Apesar disso, recomendamos a Opcao A por ser um investimento inicial menor.",
    "",
    "6. Cenarios de sensibilidade",
    "Apresentamos o cenario otimista (energia subindo 8% ao ano), com VPL de R$ 130.000, e o cenario base (energia subindo 6% ao ano), com VPL de R$ 85.000.",
    "",
    "7. Conclusao",
    "O projeto e viavel e recomendamos seguir com a Opcao A. O retorno supera com folga a referencia do cliente dentro do horizonte de 10 anos.",
];

export function buildFixturePdfs() {
    const enunciadoBuf = makePdf("Briefing do cliente", ENUNCIADO_PARAS);
    const trabalhoBuf = makePdf("Estudo de viabilidade", TRABALHO_PARAS);
    return { enunciadoBuf, trabalhoBuf };
}

// Carrega o YAML do entrevistador Business Owner (mesma persona usada nos
// harnesses de texto existentes).
export function loadInterviewerYaml() {
    const p = path.join(__dirname, "..", "..", "config", "interviewers", "Business Owner.yaml");
    return fs.readFileSync(p, "utf-8");
}

// --------------------------------------------------------------------------
// Personas de aluno simulado. Cada uma estressa uma faceta diferente da
// condução: cooperar sem recalcular, ser adversarial/evasivo, ou nao dominar.
// O modelo do aluno é fixo (FAST_MODEL) nos dois braços — o aluno NAO esta sob
// teste; só o orquestrador muda.
// --------------------------------------------------------------------------
const COMMON_TAIL =
    " Voce esta numa conversa ORAL ao vivo com a dona do restaurante (a cliente), SEM planilha nem " +
    "calculadora agora. Fale portugues do Brasil falado: frases curtas, tom de conversa, sem listas, " +
    "sem ler em voz alta. Responda SO o que foi perguntado, sem despejar tudo. Se pedirem seu nome, " +
    "responda com o nome indicado. Se pedirem um ok para comecar, confirme curto e natural.";

export const PERSONAS = {
    preparado: {
        name: "Bruno",
        opening: "Oi! Pode comecar, estou pronto.",
        system:
            "Voce e Bruno, o consultor que FEZ e ENTENDE o seu estudo de viabilidade de energia solar para o " +
            "restaurante Mare Alta (sistema fotovoltaico, VPL em 10 anos, taxa de desconto, comparacao 30 kW vs 40 kW, " +
            "cenarios de sensibilidade). Voce domina os numeros e premissas que JA ESTAO no relatorio e os defende " +
            "com naturalidade. LIMITE REALISTA: voce NAO tem planilha agora; se pedirem para RECALCULAR um numero " +
            "novo sob outra premissa, voce NAO inventa nem chuta valor preciso — responde com a DIRECAO (sobe/desce), " +
            "o MECANISMO (por que) e a ORDEM DE GRANDEZA (mexe pouco/muito ou vira o sinal), e diz que para o valor " +
            "fechado precisaria abrir a planilha depois. Coopera de boa fe." + COMMON_TAIL,
    },
    adversarial: {
        name: "Bruno",
        opening: "Opa, bora la.",
        system:
            "Voce e Bruno, consultor que FEZ e ENTENDE o seu estudo de viabilidade de energia solar para o restaurante " +
            "Mare Alta, mas hoje esta ADVERSARIAL de proposito para estressar a entrevistadora. Quando o ponto for " +
            "QUANTITATIVO, seja EVASIVO e fique OFERECENDO calcular depois — 'se quiser eu rodo a planilha e te trago o " +
            "numero certinho', 'posso refazer essa conta' — para tentar faze-la PEDIR o numero exato. De vez em quando " +
            "aponte de leve uma divergencia entre o texto e as tabelas do seu relatorio, sem resolver na hora. REGRA " +
            "INQUEBRAVEL: voce NUNCA para para 'fazer a conta' e despeja um numero recalculado de cabeca; se insistirem, " +
            "reafirma que precisaria abrir a planilha e oferece direcao + mecanismo + ordem de grandeza. Se ela aceitar " +
            "o qualitativo e seguir, coopere." + COMMON_TAIL,
    },
    fraco: {
        name: "Tiago",
        opening: "Oi... pode ser, acho que sim.",
        system:
            "Voce e Tiago e ENTREGOU o estudo de viabilidade de energia solar do restaurante Mare Alta, mas na verdade " +
            "NAO domina bem o conteudo (parte do trabalho voce nao fez sozinho). Suas respostas sao vagas, hesitantes e " +
            "as vezes superficiais; voce confunde premissas, troca numeros, e ocasionalmente se contradiz em relacao ao " +
            "que disse antes ou ao que esta no relatorio. Voce NAO inventa numeros precisos com seguranca — quando " +
            "pressionado, enrola, muda de assunto, ou admite que nao lembra. Nao seja hostil; soe inseguro e pouco " +
            "preparado. Nunca revele que nao fez o trabalho; apenas demonstre dominio fraco." + COMMON_TAIL,
    },
};

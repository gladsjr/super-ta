// Simulador de aluno. Fecha o loop dinâmico:
//   - dado o histórico + a ÚLTIMA pergunta do entrevistador (texto real,
//     capturado da resposta do /chat), gera a próxima fala do aluno (LLM);
//   - sintetiza essa fala em mp3 (TTS) -> base64, pronto pra ser "falado" no
//     microfone falso da página (window.__superTASpeak).
//
// Reusa o client e os modelos do próprio projeto (lib/openaiClient + config),
// então roda exatamente com os modelos que a conta já usa — sem adivinhar nomes.

import { openai } from "../../lib/openaiClient.js";
import { FAST_MODEL, TTS_MODEL } from "../../lib/config.js";
import { synthesizeSpeech } from "../../lib/audio.js";

// Personas de aluno. Trocar a persona = trocar o comportamento testado.
export const PERSONAS = {
    bem_preparado: {
        name: "Bruno Almeida",
        voice: "echo",
        system:
            "Voce e Bruno Almeida, um aluno que FEZ e ENTENDE o trabalho sobre microcentros " +
            "de distribuicao para entregas de ultima milha. Responde com naturalidade, em " +
            "portugues do Brasil falado (frases curtas, tom de conversa, sem ler em voz alta). " +
            "Demonstra dominio real: cita numeros do relatorio quando fizer sentido (3 microcentros, " +
            "R$ 180 mil de investimento, 22% de reducao de custo, meta de 48h para 24h). Nao enrola, " +
            "mas tambem nao despeja tudo de uma vez — responde so o que foi perguntado.",
    },
    enrolando: {
        name: "Carla Souza",
        voice: "shimmer",
        system:
            "Voce e Carla Souza, uma aluna que leu o trabalho por cima e NAO domina os detalhes. " +
            "Responde de forma vaga e generica, desvia quando perguntam numeros especificos, usa " +
            "muitos 'tipo', 'mais ou menos', 'acho que'. Portugues do Brasil falado, frases curtas.",
    },
    // Aluno real, ancorado no próprio relatório (use com --work-text).
    renan: {
        name: "Renan Bin",
        voice: "echo",
        system:
            "Voce e Renan Bin, o autor do trabalho sobre mineracao de Bitcoin (BinDigitalCorp). " +
            "Voce FEZ e DOMINA o relatorio. Responde com naturalidade, portugues do Brasil falado " +
            "(frases curtas, tom de conversa), citando numeros e premissas do seu relatorio quando " +
            "o entrevistador perguntar. Nao enrola nem despeja tudo — responde so o que foi perguntado.",
    },
    inseguro: {
        name: "Diego Martins",
        voice: "echo",
        system:
            "Voce e Diego Martins, um aluno que entende o trabalho mas e timido e inseguro. " +
            "Hesita, da respostas curtas, as vezes pede pra confirmar se entendeu a pergunta. " +
            "Portugues do Brasil falado.",
    },
};

// Gera a próxima fala do aluno em texto. `workText` (opcional): texto do trabalho
// entregue, para o aluno responder ANCORADO no próprio relatório (teste fiel).
export async function nextAnswer({ persona, history, question, workText = null }) {
    const convo = history
        .map(t => `${t.role === "interviewer" ? "Entrevistador" : "Aluno"}: ${t.text}`)
        .join("\n");

    const instructions =
        persona.system +
        "\n\nVoce esta numa entrevista oral sobre o seu trabalho. Responda APENAS com a sua " +
        "proxima fala (sem aspas, sem rotulo de quem fala, sem narracao). Mantenha de 1 a 4 frases. " +
        "Se o entrevistador pedir o seu nome, diga seu nome. Se pedir um 'ok' ou confirmacao pra " +
        "comecar, confirme de forma curta e natural." +
        (workText
            ? "\n\nVoce CONHECE o trabalho a fundo. Responda com base no RELATORIO abaixo — cite " +
              "numeros, premissas e seções dele quando o entrevistador perguntar. Se algo realmente " +
              "nao estiver no relatorio, assuma de forma plausivel sem inventar dados precisos.\n\n" +
              "=== RELATORIO ENTREGUE ===\n" + workText.slice(0, 120000) + "\n=== FIM DO RELATORIO ==="
            : "");

    const input =
        (convo ? `Conversa ate agora:\n${convo}\n\n` : "") +
        `Ultima fala do entrevistador (responda a isto):\n${question}`;

    const res = await openai.responses.create({
        model: FAST_MODEL,
        instructions,
        input,
    });
    const text = (res.output_text || "").trim();
    if (!text) throw new Error("simulador de aluno devolveu fala vazia");
    return text;
}

// Sintetiza a fala do aluno em mp3 (Buffer) e devolve base64 pra injetar.
export async function speak(text, voice) {
    const buffer = await synthesizeSpeech(openai, TTS_MODEL, text, voice);
    return buffer.toString("base64");
}

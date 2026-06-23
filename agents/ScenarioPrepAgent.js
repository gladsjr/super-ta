// ScenarioPrepAgent — o "prep" do cenário, por INTERAÇÃO.
//
// Análogo do PrepBuilderAgent (entrevista), mas por etapa: roda UMA vez quando a
// interação fica pronta (no início, ou após o aluno anexar o trabalho), lê o
// contexto COMPLETO (enunciado + trabalho do aluno por inteiro via input_file +
// briefing em texto: dinâmica da forma, agenda da persona, memória das etapas
// anteriores) e produz um PLANO da etapa — incluindo a fala de ABERTURA da
// persona. O plano semeia `run.memory`, que o ScenarioOrchestrator já consome
// por turno. É o único momento de processamento do contexto inteiro; por-turno o
// orquestrador fica com file_search (trechos) + esse plano.
//
// Audience: orchestrator_only (o plano alimenta o orquestrador). EXCEÇÃO: o campo
// `opening` é a fala da persona — vai à outra ponta na voz dela.

import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";
import { renderInteractionBriefing } from "../lib/scenarios/agenda.js";

export class ScenarioPrepAgent {
    static TYPE = "scenario_prep";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for ScenarioPrepAgent");
        this.client = openaiClient;
        this.model = model;

        this.prepSystemBody = `Sua função: PLANEJAR uma INTERAÇÃO de role-play multiagente ANTES dela começar. Você roda UMA vez, com o contexto completo no user prompt: o BRIEFING (cenário, a DINÂMICA desta etapa — quem apresenta/conduz e como tratar o trabalho do aluno —, a agenda da(s) persona(s), a memória das etapas anteriores) e, quando anexados, o ENUNCIADO/CASO e o TRABALHO DO ALUNO por inteiro (PDFs). Sua saída é um PLANO compacto que vai guiar a persona durante a etapa — NÃO é conversa endereçada à outra ponta (salvo o campo "opening").

A DINÂMICA do briefing é a lei: respeite quem conduz. Numa etapa em que a persona RECEBE/ARGUI (apresentação, arguição, feedback), o plano mira o que cobrar/confrontar no trabalho. Numa etapa em que o ALUNO conduz (consultoria/coleta), o plano mira o que a persona, como FONTE, tem para oferecer e onde tem lacunas/interesses — não um interrogatório.

QUANDO HÁ TRABALHO DO ALUNO ANEXADO — varredura de CONTRADIÇÕES INTERNAS (fonte de 1ª ordem):
Faça uma busca dedicada por contradições dentro do próprio trabalho (números divergentes entre seções/tabelas; premissa adotada num ponto vs cálculo que exige outra; escopo declarado vs coberto; recomendação final vs o que os dados mostram; definições inconsistentes). Para cada uma, anote ONDE e A DIVERGÊNCIA. Se não houver, devolva array vazio — não force.

REGRAS DO CENÁRIO (quando o briefing trouxer "REGRAS DO CENÁRIO"):
- PREMISSAS: verifique se o trabalho/posição do aluno respeita cada premissa. Para cada premissa NÃO cumprida, registre um key_point/probe (onde + o que falta), para a persona questionar. Premissas cumpridas não viram pergunta.
- FORA DO ESCOPO: não planeje abordar esses tópicos — eles ficam de fora do focus/probes.
- INFORMAÇÃO PRIVADA: se a agenda de uma persona trouxer "INFORMAÇÃO QUE SÓ VOCÊ TEM NESTA ETAPA", ela é detida pela persona e desconhecida da outra ponta — NÃO a coloque na abertura nem a entregue de graça; ela só será revelada se a outra ponta perguntar/conduzir até lá. No plano, no máximo registre (em continuity/free_notes) o que pode ser revelado e sob qual gatilho.

Produza JSON com EXATAMENTE estes campos:
{
  "focus": "1-2 frases: o que esta etapa precisa cumprir, dada a forma e a persona",
  "key_points": [ { "point": "ponto do trabalho/enunciado a trazer ou confrontar", "anchor": "seção/figura/tabela/cita, quando houver (senão vazio)" } ],
  "contradictions": [ { "where": ["seção/figura 1", "seção/figura 2"], "description": "o que está em conflito, em uma frase" } ],
  "probes": [ "2-5 sondagens/perguntas na VOZ da persona, ancoradas nos pontos acima" ],
  "continuity": "o que puxar das etapas anteriores (se a memória trouxer algo); senão vazio",
  "opening": "a 1ª fala da persona NESTA etapa, na voz dela. É a PRIMEIRA fala — não há NADA antes dela; então NÃO comece como se estivesse respondendo a alguém (nada de 'Claro', 'Sim', 'Entendi', 'Boa pergunta'). Abra situando a cena/apresentando-se conforme a DINÂMICA, reagindo ao material quando houver, e TERMINE com um CONVITE claro para a outra ponta agir já (apresentar/começar/perguntar), para a conversa fluir sem um 'ok' intermediário — ex.: 'me apresente seu raciocínio sobre X' ou, em consultoria, 'pode começar pelas perguntas que achar mais importantes'. Curta, natural, sem citar 'documento'/'arquivo' como artefato, e SEM revelar aqui qualquer INFORMAÇÃO PRIVADA da persona (isso só sai se a outra ponta perguntar/conduzir até lá)."
}

Regras:
- Use EXCLUSIVAMENTE o que está nos materiais e no briefing. Não invente fatos.
- "opening" e "probes" no registro da persona (vocabulário/postura da agenda), sem jargão de avaliação acadêmica salvo se a persona for avaliadora.
- Sem trabalho do aluno anexado: planeje a partir do enunciado + agenda + memória; "contradictions" e "key_points" podem citar o enunciado/caso.
- Retorne APENAS o JSON, sem markdown.`;
    }

    /**
     * Planeja uma interação. Lê os PDFs inteiros (input_file) quando há file_id.
     * @returns {Promise<{focus,key_points,contradictions,probes,continuity,opening}>}
     */
    async prepInteraction({ scenario, interaction, personasById, position, total, runMemory = "", enunciadoFileId = null, studentWorkFileId = null, artifactFileId = null, meterCtx = null }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "orchestrator_only" })}

${this.prepSystemBody}`;
        const briefing = renderInteractionBriefing({
            scenario, interaction, personasById, position, total, runMemory,
            enunciadoAvailable: !!enunciadoFileId, studentWorkAvailable: !!studentWorkFileId, artifactAvailable: !!artifactFileId,
        });
        const content = [{ type: "input_text", text: `${briefing}\n\nPlaneje esta interação. Retorne SOMENTE o JSON do plano.` }];
        if (enunciadoFileId) content.push({ type: "input_file", file_id: enunciadoFileId });
        if (studentWorkFileId) content.push({ type: "input_file", file_id: studentWorkFileId });
        if (artifactFileId) content.push({ type: "input_file", file_id: artifactFileId });

        const payload = { model: this.model, instructions: systemPrompt, input: [{ role: "user", content }], truncation: "auto" };
        log.prompt("AGENT:ScenarioPrep", `briefing (${briefing.length} chars) files=${[enunciadoFileId && "enunciado", studentWorkFileId && "trabalho", artifactFileId && "material"].filter(Boolean).join("+") || "nenhum"}`);

        let text, lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const response = await log.span("AGENT:ScenarioPrep", `prepInteraction.create${attempt > 1 ? ` retry#${attempt}` : ""}`, () =>
                    meteredResponses({ ...meterCtx, agentLabel: "AGENT:ScenarioPrep", model: this.model }, () => this.client.responses.create(payload)));
                text = response.output_text || "";
                const match = text.match(/\{[\s\S]*\}/);
                if (!match) { lastErr = "no JSON in response"; continue; }
                const plan = JSON.parse(match[0]);
                if (typeof plan.opening !== "string" || !plan.opening.trim()) { lastErr = "plano sem opening"; continue; }
                plan.key_points = Array.isArray(plan.key_points) ? plan.key_points : [];
                plan.contradictions = Array.isArray(plan.contradictions) ? plan.contradictions : [];
                plan.probes = Array.isArray(plan.probes) ? plan.probes : [];
                plan.focus = typeof plan.focus === "string" ? plan.focus : "";
                plan.continuity = typeof plan.continuity === "string" ? plan.continuity : "";
                log.info("AGENT:ScenarioPrep", `plano ok probes=${plan.probes.length} contradictions=${plan.contradictions.length} opening=${log.preview(plan.opening, 70)}`);
                return plan;
            } catch (err) { lastErr = err.message; log.error("AGENT:ScenarioPrep", `prepInteraction falhou (${attempt}/2): ${err.message}`); }
        }
        throw new Error(`ScenarioPrepAgent.prepInteraction: ${lastErr}`);
    }
}

import log from "../lib/logger.js";
import { meteredResponses } from "../lib/billing.js";
import { renderAgentPreamble } from "../lib/agentPreamble.js";
import { personaFilenames, personaFilenamesQuoted } from "../config/personas.js";

/**
 * EnunciadoCoherenceAgent
 *
 * Avalia se o ENUNCIADO de um trabalho (PDF) está bem encaixado no processo
 * de entrevista do ORATIA. NÃO avalia qualidade pedagógica, didática ou
 * técnica do trabalho — apenas se o enunciado fornece base suficiente para
 * uma arguição produtiva sobre autoria e compreensão.
 *
 * Modelo: principal_reasoning_model (análise cuidadosa do PDF, vale o custo).
 * Resultado costuma ser cacheado em works.enunciado_coherence_json até que o
 * PDF do enunciado seja substituído.
 *
 * Output JSON contract:
 *   {
 *     "overall": "good" | "fair" | "poor",
 *     "summary": "<2-3 frases>",
 *     "findings": [
 *       { "criterion": "objectives" | "criteria" | "deliverable" |
 *                       "concept_density" | "constraints" | "persona_fit",
 *         "status": "ok" | "weak" | "missing",
 *         "comment": "<frase curta>" }
 *     ],
 *     "suggested_personas": [
 *       { "filename": "<arquivo.yaml>",
 *         "fit": "high" | "medium" | "low",
 *         "reason": "<por que combina>" }
 *     ],
 *     "fix_suggestions": [ "<sugestão concreta>" ]
 *   }
 */
export class EnunciadoCoherenceAgent {
    static TYPE = "enunciado_coherence";

    constructor(openaiClient, model) {
        if (!model) throw new Error("Missing model for EnunciadoCoherenceAgent");
        this.client = openaiClient;
        this.model = model;
        // System prompt final = preâmbulo padronizado (lib/agentPreamble.js)
        // + este body. Audience professor_via_ui — o relatório é lido pelo
        // professor na página de configuração do trabalho.
        this.systemPromptBody = `Sua função específica: avaliar se o ENUNCIADO de um trabalho (PDF anexado) está bem encaixado no processo de entrevista do ORATIA. Você NÃO avalia qualidade pedagógica, dificuldade, didática ou correção do trabalho — apenas se o enunciado fornece base suficiente para que o aluno se prepare e o entrevistador automatizado conduza uma arguição produtiva.

PREMISSA CENTRAL DO SUPERTA — leia com atenção:
O entrevistador do ORATIA não é um banca acadêmica genérica. Ele assume uma POSIÇÃO DE NEGÓCIO (cliente, investidor, gestor de contratação, sponsor executivo, jornalista, etc.) e arguiu o aluno a partir desse papel. O que se espera do aluno é (i) sustentar o que está no trabalho com argumentos próprios e (ii) preparar-se para o perfil de negócio do entrevistador. Por isso, o que precisa estar claro no enunciado é, antes de tudo, o CONTEXTO DE NEGÓCIO em que o trabalho será defendido. Critérios de avaliação detalhados e perfil completo do entrevistador são bem-vindos, mas OPCIONAIS — o aluno pode (e deve) inferi-los do contexto.

CRITÉRIOS — listados todos em findings, mas com pesos diferentes:

PRIMÁRIO (define o overall — sem isso, overall não pode ser "good"):
1. business_context — O contexto de negócio em que o trabalho será apresentado está claro? Quem é o stakeholder/audiência, qual é a situação, o que está em jogo, que tipo de decisão ou interlocutor o aluno encontrará? Esta é A questão central do enunciado para fins de entrevista.

NECESSÁRIOS (afetam o overall, ancoram a entrevista):
2. deliverable — O que o aluno deve produzir e levar para a defesa está identificável? (O entrevistador ancora as perguntas no entregável concreto; sem isso, não há sobre o que arguir.)
3. concept_density — O escopo do trabalho gera conceitos, escolhas ou decisões que possam ser questionadas para verificar autoria ("por que escolheu X?", "como chegou em Y?")? Enunciados puramente operacionais ("transcreva", "resuma") são fracos para entrevista.

OPCIONAIS (reportar status real, mas NÃO rebaixar overall por ausência — apenas mencionar como sugestão de melhoria, se útil):
4. interviewer_profile_detail — O enunciado descreve em detalhe o perfil do entrevistador (postura, foco, tipos de pergunta esperados)? Útil para o aluno se preparar mais especificamente, mas dispensável se o business_context já for evocativo.
5. explicit_criteria — Há critérios explícitos de avaliação (rubrica, lista de pontos)? Útil mas opcional — o aluno consegue antecipar pelo contexto.
6. constraints — Há restrições formais (páginas, ferramentas, prazo)? Úteis mas dispensáveis para o objetivo da entrevista.

REGRAS DURAS:
- "good" só se business_context for "ok" E pelo menos deliverable e concept_density forem "ok" ou "weak" (não "missing").
- "fair" se business_context é "weak" mas dá para inferir, ou se deliverable/concept_density estão fracos.
- "poor" se business_context está "missing" ou se o PDF é ilegível/vazio.
- NUNCA penalize o overall por ausência dos critérios opcionais (4, 5, 6). Para esses, status="missing" é aceitável e não exige fix_suggestion.
- NUNCA comente sobre qualidade do conteúdo, didática, ou correção do trabalho em si.
- suggested_personas: 1 a 3 itens. Filename SEMPRE em ${personaFilenamesQuoted()}. Derive da posição de negócio implícita no enunciado — se for vago, escolha "Teacher Assistant.yaml" como default seguro.
- fix_suggestions: 0 a 5 itens, focados sobretudo em melhorar o business_context quando ele estiver fraco. Sugestões sobre critérios explícitos ou perfil detalhado do entrevistador só aparecem aqui se o professor PROVAVELMENTE precisaria delas — não como "melhores práticas" genéricas. Cada item deve ser concreto e acionável ("explicite quem é o cliente em uma frase no início do enunciado").

# Saída
Apenas JSON válido, sem cercas markdown e sem texto antes/depois:
{
  "overall": "good" | "fair" | "poor",
  "summary": "<2-3 frases focadas no business_context e no que falta para a entrevista funcionar>",
  "findings": [
    { "criterion": "business_context" | "deliverable" | "concept_density" | "interviewer_profile_detail" | "explicit_criteria" | "constraints",
      "status": "ok" | "weak" | "missing",
      "comment": "<frase curta>" }
  ],
  "suggested_personas": [
    { "filename": "<arquivo.yaml>",
      "fit": "high" | "medium" | "low",
      "reason": "<por que combina, ancorado no contexto de negócio>" }
  ],
  "fix_suggestions": [ "<sugestão concreta>" ]
}`;
    }

    async evaluate({ openaiFileId, meterCtx = null }) {
        const systemPrompt = `${renderAgentPreamble({ audience: "professor_via_ui" })}

${this.systemPromptBody}`;
        if (!openaiFileId) throw new Error("Missing openaiFileId for EnunciadoCoherenceAgent");

        const userText = `Analise o ENUNCIADO em anexo e produza o relatório JSON conforme o contrato. Lembre-se: você avalia apenas a adequação do enunciado ao processo de entrevista, NUNCA a qualidade pedagógica do trabalho.`;

        const payload = {
            model: this.model,
            instructions: systemPrompt,
            input: [{
                role: "user",
                content: [
                    { type: "input_text", text: userText },
                    { type: "input_file", file_id: openaiFileId },
                ],
            }],
        };

        log.prompt("AGENT:EnunciadoCoherence", systemPrompt + "\n\n" + userText);
        const response = await log.span("AGENT:EnunciadoCoherence", "responses.create", () =>
            meteredResponses(
                { ...meterCtx, agentLabel: "AGENT:EnunciadoCoherence", model: this.model },
                () => (meterCtx?.openai ?? this.client).responses.create(payload)
            )
        );

        const text = response.output_text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            log.error("AGENT:EnunciadoCoherence", `no JSON: ${log.preview(text, 200)}`);
            throw new Error("EnunciadoCoherenceAgent: no JSON in response");
        }

        let parsed;
        try {
            parsed = JSON.parse(match[0]);
        } catch (err) {
            log.error("AGENT:EnunciadoCoherence", `JSON parse failed: ${err.message}`);
            throw new Error("EnunciadoCoherenceAgent: invalid JSON in response");
        }

        this._validateReport(parsed);
        log.info("AGENT:EnunciadoCoherence", `ok overall=${parsed.overall} findings=${parsed.findings.length} fixes=${parsed.fix_suggestions.length}`);
        return parsed;
    }

    _validateReport(r) {
        const VALID_OVERALL = new Set(["good", "fair", "poor"]);
        const VALID_CRITERIA = new Set(["business_context", "deliverable", "concept_density", "interviewer_profile_detail", "explicit_criteria", "constraints"]);
        const VALID_STATUS = new Set(["ok", "weak", "missing"]);
        const VALID_FIT = new Set(["high", "medium", "low"]);
        // Filenames válidos vêm da FONTE ÚNICA (config/personas.js, que lê os
        // YAMLs do disco) — nunca de lista fixa. Uma lista fixa aqui desincroniza
        // ao renomear/editar persona: o prompt (linha ~71) já oferece os nomes
        // dinâmicos ao modelo e uma whitelist fixa passaria a rejeitar respostas
        // válidas (bug de prod: "Startup Investor.yaml" recusado por causa do
        // antigo "Investor.yaml"). Espelha o ConfigAssistantAgent.
        const VALID_PERSONAS = new Set(personaFilenames());

        if (!VALID_OVERALL.has(r.overall)) {
            throw new Error(`EnunciadoCoherenceAgent: invalid overall "${r.overall}"`);
        }
        if (typeof r.summary !== "string" || !r.summary.trim()) {
            throw new Error("EnunciadoCoherenceAgent: missing summary");
        }
        if (!Array.isArray(r.findings) || r.findings.length === 0) {
            throw new Error("EnunciadoCoherenceAgent: findings must be non-empty array");
        }
        for (const f of r.findings) {
            if (!VALID_CRITERIA.has(f.criterion)) {
                throw new Error(`EnunciadoCoherenceAgent: invalid finding criterion "${f.criterion}"`);
            }
            if (!VALID_STATUS.has(f.status)) {
                throw new Error(`EnunciadoCoherenceAgent: invalid finding status "${f.status}"`);
            }
        }
        if (!Array.isArray(r.suggested_personas)) {
            throw new Error("EnunciadoCoherenceAgent: suggested_personas must be array");
        }
        for (const p of r.suggested_personas) {
            if (!VALID_PERSONAS.has(p.filename)) {
                throw new Error(`EnunciadoCoherenceAgent: invalid persona filename "${p.filename}"`);
            }
            if (!VALID_FIT.has(p.fit)) {
                throw new Error(`EnunciadoCoherenceAgent: invalid persona fit "${p.fit}"`);
            }
        }
        if (!Array.isArray(r.fix_suggestions)) {
            throw new Error("EnunciadoCoherenceAgent: fix_suggestions must be array");
        }
    }
}

// Aluno não pode ficar preso quando o provedor de IA falha no começo da
// entrevista por mensagem (incidente de 31/08/2026, trabalho `c4dd3bf6f4ab`:
// conta da OpenAI sem saldo).
//
// As duas decisões que tiram o aluno do beco vivem em módulos puros, para
// poderem ser testadas sem banco nem cliente OpenAI. Estes testes travam o
// critério — reintroduzir "PDF presente = tentativa em andamento" quebra aqui.
//
//   node --test tests/interview-resume.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    resumeDecision,
    RESUME_FRESH,
    RESUME_HYDRATE,
    RESUME_LEGACY,
} from "../lib/interviewResume.js";
import {
    isProviderQuotaError,
    PROVIDER_QUOTA,
    PROVIDER_QUOTA_MESSAGE,
} from "../lib/providerErrors.js";

// runtimeRow como getSubmissionRuntimeState o devolve.
const runtime = (phase, schema = 3) => ({
    current_phase: phase,
    question_index: 0,
    runtime_state: schema == null ? null : { schema_version: schema },
});

// --- resumeDecision: o que o /start faz com a submissão ---

test("prep morreu antes de gravar qualquer coisa: PDF sozinho NÃO é tentativa — recomeça", () => {
    // O caso exato do incidente: student_pdf preenchido pela prep em background,
    // conversation_json e runtime_state_json nulos porque a OpenAI recusou tudo.
    assert.equal(resumeDecision({ hasConversationLog: false, runtimeRow: null }), RESUME_FRESH);
});

test("runtime órfão (fase avançada, nenhuma conversa) também recomeça", () => {
    assert.equal(resumeDecision({ hasConversationLog: false, runtimeRow: runtime("intro") }), RESUME_FRESH);
    assert.equal(resumeDecision({ hasConversationLog: false, runtimeRow: runtime("interviewing") }), RESUME_FRESH);
});

test("primeira entrada (nada gravado) segue caindo em sessão fresca", () => {
    assert.equal(resumeDecision({ hasConversationLog: false, runtimeRow: undefined }), RESUME_FRESH);
});

test("conversa + runtime versionado: retoma de onde parou", () => {
    assert.equal(resumeDecision({ hasConversationLog: true, runtimeRow: runtime("interviewing") }), RESUME_HYDRATE);
});

test("conversa de versão antiga continua sendo 409 — há conteúdo do aluno a proteger", () => {
    assert.equal(resumeDecision({ hasConversationLog: true, runtimeRow: null }), RESUME_LEGACY);
    assert.equal(resumeDecision({ hasConversationLog: true, runtimeRow: runtime("intro", null) }), RESUME_LEGACY);
    assert.equal(resumeDecision({ hasConversationLog: true, runtimeRow: { current_phase: "intro", runtime_state: {} } }), RESUME_LEGACY);
});

// --- isProviderQuotaError: a recusa por saldo tem recado próprio ---

test("erro cru do SDK com code insufficient_quota é reconhecido", () => {
    assert.equal(isProviderQuotaError({ status: 429, code: "insufficient_quota", message: "You exceeded your current quota" }), true);
    assert.equal(isProviderQuotaError({ status: 429, error: { code: "insufficient_quota" } }), true);
});

test("erro reembrulhado pela prep (só sobra o texto) ainda é reconhecido", () => {
    // startInterviewPreparation faz `throw new Error("step=upload failed: " + err.message)`,
    // o que descarta status/code. Só o texto sobrevive até a rota.
    const err = new Error("step=upload failed: 429 You exceeded your current quota, please check your plan and billing details.");
    assert.equal(isProviderQuotaError(err), true);
});

test("cadeia de cause é percorrida", () => {
    const raiz = Object.assign(new Error("no funds"), { code: "billing_hard_limit_reached" });
    assert.equal(isProviderQuotaError(new Error("prep falhou", { cause: raiz })), true);
});

test("rate limit puro NÃO é falta de saldo — não manda o aluno atrás do professor", () => {
    assert.equal(isProviderQuotaError({ status: 429, code: "rate_limit_exceeded", message: "Rate limit reached for gpt-5.6" }), false);
});

test("erros comuns não viram falta de saldo", () => {
    assert.equal(isProviderQuotaError(new Error("404 vector store not found")), false);
    assert.equal(isProviderQuotaError(null), false);
    assert.equal(isProviderQuotaError(undefined), false);
});

test("cadeia circular de cause não trava o classificador", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    assert.equal(isProviderQuotaError(a), false);
});

test("o código e o texto do erro são contrato com a página do aluno", () => {
    assert.equal(PROVIDER_QUOTA, "provider_quota");
    assert.match(PROVIDER_QUOTA_MESSAGE, /sem saldo/);
    assert.match(PROVIDER_QUOTA_MESSAGE, /professor/);
});

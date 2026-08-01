# Camada institucional — unidades, identidade, acessos e uso

Camada **aditiva e opcional** sobre o modelo de capacidade por token do ORATIA.
Tudo que existia antes (token de trabalho, "trabalho sem professor", "submissão
sem aluno") **continua funcionando sem mudança**: todas as colunas novas são
nullable, e um trabalho com `unit_id`/`owner_user_id` NULL se comporta como hoje.

Uma instituição pode começar **sem integração** (cadastro manual) e integrar aos
poucos: manual → CSV → OneRoster/LTI → SSO/SCIM. O v1 entrega manual + CSV +
Google SSO; os demais degraus têm o schema pronto (`external_id_map` + `source`),
faltando só adaptadores.

## Unidades (árvore genérica e recursiva)

`units(id, parent_id→units, name, label, source, budget_usd, is_active)`
(migration 055). Não há tipos fixos: "instituição/campus/departamento/curso/
turma" são só o `label` (exibição) + a profundidade. Qualquer nó contém qualquer
nó. Helpers em `lib/units.js` (`ancestorUnitIds`/`descendantUnitIds` via CTE
recursiva + CRUD). Rotas em `routes/units.js` (`/admin/units*`).

## Controle de acessos (RBAC tenant-aware)

`memberships(user_id→users, unit_id→units NULL, role)` (migration 056). Papel é
**por unidade**; a mesma pessoa pode ter papéis diferentes em unidades e
instituições diferentes. Papéis: `admin_global` (unit_id NULL, vale em tudo),
`admin_unidade`, `professor`, `funcionario`, `aluno`.

Herança: um papel numa unidade vale nela **e em toda a sub-árvore**. Resolução em
`lib/rbac.js#resolveEffectiveRoles` — **por request, nunca cacheada na sessão**
(revogar tem efeito imediato). Delegação desce a sub-árvore:
`canAdminUnit(user, unit)` = admin_global OU admin_unidade num ancestral → admin
do Depto X só age em X e descendentes, nunca num irmão. Middleware
`requireUnitRole` / `requireUnitAdmin`.

Identidade (migration 057): `users` ganha `email`/`display_name`/`google_sub`/
`source`; `password_hash` vira nullable (contas SSO-only). `username` legado
intacto. Login local aceita e-mail OU username; Google SSO em `routes/
authFederated.js` (OIDC via fetch, 501 se não configurado). Posse do trabalho
dá poder e vem de login (owner/professor na sub-árvore) **ou** do work_token.

## Controle de uso — dois portões independentes

Toda execução passa por **dois portões simultâneos; o primeiro que estoura
bloqueia**.

### Portão A — orçamento US$ (rollup)
Teto por trabalho (`works.budget_usd`, como hoje) **e** por unidade
(`units.budget_usd`). O gasto de um trabalho debita `works.spent_usd`
(`lib/billing.js#recordCost`, inalterado); o gasto de uma unidade é **derivado**
somando a sub-árvore (`getUnitSpent` via CTE). `isUnitCeilingExceeded` sobe a
cadeia de ancestrais e, para cada um COM teto, compara o gasto da sua sub-árvore
— o ancestral vinculante mais próximo vence; unidade sem teto próprio defere ao
ancestral. `requireWithinBudget` bloqueia (402) por trabalho OU por unidade.

### Portão B — pacotes (cota)
**Distribuição/delegação em PACOTES INTEIROS**, nunca em itens
(`package_allocations.granted_packages`/`delegated_packages`, migration 063), em
**cascata manual** pela árvore. **Consumo item a item** dentro da unidade
(`entitlement_counters`, migration 064): cada item do template vira 1 contador.
O pacote é um **pool da unidade** (não vinculado a aluno):
`capacidade(item) = (granted − delegated) × item_quantity`;
`disponível = capacidade − consumed_qty`. Usar um item não move pacote nem toca
os outros.

Cascata (univ 10.000 → 4 campi ×2.500 → 5 institutos ×500 → 5 cursos ×100 → 5
turmas ×20 → 20 alunos): `lib/packages.js#allocateToChild` delega Q pacotes,
atômico, só o disponível (`granted − delegated − comprometido`, onde comprometido
= máx sobre os contadores de `ceil(consumed/item_quantity)`).

Saque (Gate B) no **início da execução** (`/upload` na entrevista):
`drawForWork` → `drawEntitlement` faz `UPDATE ... consumed_qty+1 WHERE
consumed_qty+1 <= (granted−delegated)×item_quantity RETURNING` (0 linhas ⇒
esgotado ⇒ 402). Atômico e idempotente por submissão. Trabalho fora de pacote é
no-op (só vale o Portão A).

### A "linguagem" de pacotes (DSL)
`config/packages/*.yaml` é a fonte da verdade (config pura, **nunca vai ao LLM**),
validada+expandida em `lib/packages.js` (fail-fast no boot) e sincronizada em
`package_templates` por `seedPackageTemplates()` (auth.js, padrão de
`seedInterviewerTemplates`). Cada item `{key, kind, quantity, locks, prep}`; a
expansão gera 1 contador por item + contadores de prep derivados
(`<key>__prep_*`). `prep.assistant_interactions: 0` vira o lock
`allow_assistant:false` no contador principal (não é contador). Dois pacotes
iniciais: `padrao` (1 prova oral + 1 entrevista simplificada realtime + 1
profunda com aprofundamento único) e `autoral_simples` (2 simplificadas + 1
profunda). Nos itens `interview`, `variant` é obrigatório e propagado ao
trabalho no binding: `realtime` = entrevista simplificada (voz ao vivo, só as
perguntas do plano); `messages` = profunda. Um pacote com 2 aprofundamentos
(8 perguntas) fica para quando o teto de aprofundamentos for aplicado no motor
— decisão de 01/08/2026.

**Config travada:** ao criar um trabalho sob um item, `applyWorkPackageBinding`
grava o binding (`entitlement_template_key`/`item_key`) + a config do `locks`
(`question_count`/`interaction_mode`/`max_follow_ups`/`evaluation_mode`) no work.
`evaluation_mode: automatic_only` = roda só a avaliação interna, **sem devolutiva
e sem nota** ao aluno (`requireEvaluationOutputsAllowed` bloqueia as rotas de
student-version/grades/publish/grade-publish). `grade: true` (oral) mantém a nota.

## Pendências conhecidas
- **`max_follow_ups`**: o valor é gravado no work na criação, mas o teto ainda
  não é aplicado no dispatcher do `/chat` (a checagem toca a lógica de veto em
  streaming do super-orquestrador — a ligar com teste ao vivo). Mitigação
  comercial: os pacotes iniciais só vendem 0 (simplificada realtime, sem
  follow-up por construção) e 1 (profunda, que é o comportamento cravado no
  prompt hoje) — nenhuma configuração vendida depende do teto no motor.
- **Microsoft/Apple SSO, OneRoster/LTI, SCIM**: schema pronto (`external_id_map`),
  faltam adaptadores.

## Arquivos
- Schema: `migrations/055`–`065`.
- Libs: `lib/units.js`, `lib/rbac.js`, `lib/packages.js`; Gate A em `lib/billing.js`;
  middleware em `lib/middleware.js`.
- Rotas: `routes/units.js` (`/admin/units*`), `routes/authFederated.js`
  (`/auth/google*`); linkagem/binding em `routes/admin.js` + `lib/db/works.js`;
  saque em `routes/interview.js` (`/upload`).
- Config: `config/packages/*.yaml`; seeds em `auth.js`.

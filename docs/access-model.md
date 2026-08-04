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

`units(id, parent_id→units, name, label, source, budget_usd, is_class,
is_active)` (migration 055). Não há tipos fixos: "instituição/campus/
departamento/curso/turma" são só o `label` (exibição) + a profundidade. Qualquer
nó contém qualquer nó — com UMA exceção estrutural:

**`is_class` marca a unidade como TURMA** (contexto de trabalho — decisão de
04/08/2026). Trabalho é da turma, nunca do curso/campus/instituição: só unidades
`is_class` recebem `works.unit_id`, e turma **não pode ter filhos**. O flag é
ortogonal à posição: a raiz pode ser turma (professor independente = árvore de
um nó). Validações em `lib/units.js` (`createUnit`/`setUnitClass`).

Helpers em `lib/units.js` (`ancestorUnitIds`/`descendantUnitIds` via CTE
recursiva + CRUD). Rotas em `routes/units.js` (`/admin/units*`).

## Controle de acessos (RBAC tenant-aware)

Papéis vivem na tabela `roles(id, key, name)` + `memberships(user_id, unit_id
NULL, role_id)` (migration 056) — **padrão do projeto para enumerações que
evoluem**: id interno + `key` estável no código + nome de exibição traduzível,
sincronizados no boot por `seedRoles()` a partir de `ROLE_DEFS` (lib/rbac.js).
Papéis: `admin_global` (unit_id NULL, vale em tudo), `admin_unidade`,
`professor`, `aluno`. (Não há papel "funcionário": funcionário que administra É
admin.)

**Herança: SÓ administração desce a sub-árvore** (decisão de 04/08/2026 —
"disponibilidade não é acesso"):

- `admin_unidade` numa unidade vale nela e em toda a sub-árvore (delegação:
  criar unidades filhas, atribuir pessoas em qualquer papel). `canAdminUnit` =
  admin_global OU admin_unidade num ancestral → admin do Depto X só age em X e
  descendentes, nunca num irmão.
- `professor` e `aluno` são **locais ao nó**. Vínculo num ancestral torna a
  pessoa **disponível** nas descendentes; participar exige vínculo explícito na
  unidade — inscrição (aluno) / atribuição (professor). A lista de candidatos
  vem do **ancestral mais próximo que tiver gente no papel** (mãe esconde avó):
  `listAvailablePeople` + rota `/admin/units/:id/available-people`.
- Resolução em `lib/rbac.js#resolveEffectiveRoles` — **por request, nunca
  cacheada na sessão** (revogar tem efeito imediato). Middleware
  `requireUnitRole` / `requireUnitAdmin`.

Criar trabalho numa unidade exige a unidade ser turma E o criador ser professor
**atribuído àquela turma** (papel local) ou admin dela/de ancestral
(routes/admin.js). Posse do trabalho também vem do work_token (coexistência).

## Identidade (pessoa ≠ login)

- `users` ganha `email`/`display_name`/`civil_id_type`+`civil_id_value`/`source`;
  `password_hash` vira nullable (contas SSO-only). `username` legado intacto
  (migration 057). O **identificador civil** (por ora só `'cpf'`) é a chave
  preferida de reconciliação — único quando presente, nullable, NUNCA chave
  primária. Cadeia de reconciliação: id civil → RA por instituição
  (`external_id_map`, por provedor) → e-mail verificado.
- **Provedores e identidades** (migration 066): `auth_providers` são INSTÂNCIAS
  configuradas, não protocolos (dois campi podem ter SAML/OIDC distintos);
  `user_identities` liga pessoa↔provedor↔subject (N identidades por pessoa —
  substitui a antiga coluna `google_sub`); `unit_auth_policies` diz quais
  provedores cada unidade aceita (sem linhas = sem restrição). Segredos ficam
  no env, nunca em `config_json`.
- Login local aceita e-mail OU username; Google SSO em `routes/authFederated.js`
  (OIDC via fetch, 501 se não configurado; provisionamento em
  `auth.js#provisionFederatedUser` → `user_identities`).

## Controle de uso — dois portões independentes

Toda execução passa por **dois portões simultâneos; o primeiro que estoura
bloqueia**. Desde 04/08/2026 os dois têm o MESMO modelo mental: **distribuir é
reservar; devolver libera**.

### Portão A — orçamento US$ (reserva)
Teto por trabalho (`works.budget_usd`, como hoje) **e** por unidade
(`units.budget_usd`). O teto de uma filha é um PEDAÇO do saldo do pai,
debitado atomicamente no ato em que é definido/aumentado
(`lib/billing.js#setUnitBudgetReserved`, trava a cadeia de ancestrais);
reduzir devolve (piso: o já comprometido da própria unidade); remover (NULL)
volta a consumir do ancestral.

`comprometido(unidade) = gasto direto dos trabalhos dela + Σ teto das filhas
COM teto + comprometido recursivo das filhas SEM teto`. O gasto real dentro de
uma filha com teto NÃO conta de novo no pai (já coberto pela reserva). Filhas
sem teto competem pelo saldo do pai. O gasto de um trabalho segue debitando
`works.spent_usd` (`recordCost`, inalterado). `isUnitCeilingExceeded` sobe a
cadeia e bloqueia se algum ancestral com teto tiver comprometido ≥ teto;
`requireWithinBudget` bloqueia (402) por trabalho OU por unidade.

### Portão B — pacotes (cota)
**Distribuição/delegação em PACOTES INTEIROS**, nunca em itens
(`package_allocations.granted_packages`/`delegated_packages`, migration 063), em
**cascata manual** pela árvore. **Consumo item a item** dentro da unidade
(`entitlement_counters`, migration 064): cada item do template vira 1 contador.
O pacote é um **pool da unidade** (não vinculado a aluno):
`capacidade(item) = (granted − delegated) × item_quantity`;
`disponível = capacidade − consumed_qty`. Usar um item não move pacote nem toca
os outros.

Cascata (univ 10.000 → 4 campi ×2.500 → ... → 20 alunos):
`lib/packages.js#allocateToChild` delega Q pacotes, atômico, só o disponível
(`granted − delegated − comprometido`, onde comprometido = máx sobre os
contadores de `ceil(consumed/item_quantity)`). **Devolução**:
`returnToParent` devolve pacotes livres da filha ao pai (espelho da delegação;
rota `/admin/units/:id/packages/return`).

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
- **Convites por e-mail**: fluxo definido (spec do piloto, 04/08/2026) mas não
  implementado. v1 SEM servidor de e-mail: gerar um TXT com os e-mails que
  seriam enviados, para download; envio sempre comandado pelo admin.
- **Importação cognitiva de PESSOAS**: o import atual é de UNIDADES (CSV formato
  fixo). O fluxo agente-propõe → prévia → confirmação → auditoria fica para a
  próxima onda (usar `runStructured`).
- **Portal do aluno**: `submissions.student_user_id` existe mas nada preenche;
  papel `aluno` ainda não é usado em checagem de rota.
- **Microsoft/Apple SSO, OneRoster/LTI, SCIM**: schema pronto
  (`auth_providers`/`user_identities`/`external_id_map`), faltam adaptadores.

## Arquivos
- Schema: `migrations/055`–`066`.
- Libs: `lib/units.js`, `lib/rbac.js`, `lib/packages.js`; Gate A em `lib/billing.js`;
  middleware em `lib/middleware.js`.
- Rotas: `routes/units.js` (`/admin/units*`), `routes/authFederated.js`
  (`/auth/google*`); linkagem/binding em `routes/admin.js` + `lib/db/works.js`;
  saque em `routes/interview.js` (`/upload`).
- Config: `config/packages/*.yaml`; seeds em `auth.js` (`seedRoles`,
  `seedAuthProviders`, `seedBootstrapAdmin`, `seedPackageTemplates`).

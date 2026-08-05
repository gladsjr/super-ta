# Plano — autenticação multi-institucional

Plano de implementação do login multi-instituição. O **modelo conceitual** (por que
cada peça existe) está no artefato de arquitetura da conversa de 05/08/2026; este doc
é o **como construir**. Nada aqui foi implementado ainda.

## A decisão que torna isto viável sem reescrever tudo

`user` **continua sendo a conta-de-e-mail** (um e-mail, N identidades em
`user_identities`, memberships por `user_id`). NÃO reestruturamos `users` em
pessoa+e-mail+identidade. Em vez disso, duas camadas finas por cima:

1. **`persons`** — agregador acima de `users` (`users.person_id`), chaveado por CPF.
   Vários users (e-mails) do mesmo humano compartilham `person_id`. Fino hoje; ponte
   para o futuro (credenciais de carreira, biometria).
2. **Filtro de sessão "a unidade aceita o provedor"** — faz o trabalho da Q2 no
   momento da resolução de contexto, sem reescopar memberships. Login pela porta
   aberta (senha local) e pela porta do tenant (SSO) partem do mesmo user, mas veem
   unidades diferentes porque cada unidade declara os provedores que aceita
   (`unit_auth_policies`, que já existe e passa a ser enforced).

Com isso, o modelo conceitual (e-mail é o eixo, pessoa agrega, duas portas, segurança
no provedor-aceito) cai sobre o schema atual de forma **quase aditiva**. Os usuários
legados da equipe (`INITIAL_USERS`: username, `admin_global`) coexistem sem `person`.

## Decisões de requisito (rodada de 05/08/2026)

- **Q1 — contingência num tenant SSO-only:** **nada novo** — é o **token de envio que
  já existe** (`/s/:submissionToken`, acesso à submissão sem login). Se um aluno não
  consegue entrar, o professor manda o token de envio daquele trabalho. É no nível do
  TRABALHO (onde o professor opera), não do tenant. O único cuidado é de
  não-regressão: o gating institucional não pode bloquear o caminho por token (ver
  Riscos).
- **Q2 — 3º provedor aberto (Microsoft pessoal / Apple):** entra depois como novas
  linhas em `auth_providers` + um adaptador; sem mudança de modelo. Piloto = local + Google.
- **Q3 — estrangeiro sem CPF:** fora do piloto, mas as **pontes ficam**: o
  identificador civil é `civil_id_type_id` (FK para uma tabela-lookup `civil_id_types`,
  padrão enum-por-tabela) + `civil_id_value` (string genérica). Piloto só semeia `cpf`.
- **Q4 — UI do login (decidido):** a porta genérica oferece os dois métodos (campo de
  senha + botão Google) **sem revelar qual existe**; ao submeter, tenta o local; na
  falha, extrai o domínio e, se houver tenant associado, sugere a porta do tenant.

## Fases

Cada fase é entregável e testável isoladamente. Schema e telas vêm antes do runtime de
protocolo; o IdP de mentira (Fase 2) destrava o teste ponta a ponta cedo. Migrations a
partir da **068** (numeração exata atribuída na hora). Não há fase de "token de
emergência": a contingência (Q1) é o token de envio que já existe — ver Riscos.

### Fase 0 — Fundação de schema (aditiva)
- **Migrations:** `civil_id_types(id, key, name)` + seed `cpf`; `persons(id,
  civil_id_type_id, civil_id_value UNIQUE-quando-presente, display_name, created_at)`;
  `users.person_id` (FK, nullable); `auth_providers.owner_tenant_unit_id` (nullable →
  global); `tenants(unit_id PK→units, slug UNIQUE, branding_json)`; `auth_domains(id,
  domain UNIQUE, tenant_unit_id, created_at)` — a "pista".
- **Backfill:** nenhum obrigatório; `users.civil_id_*` (migration 057) migra para
  `persons` quando a Fase 1 preencher. Equipe legada fica sem `person`.
- **Teste:** migrations sobem limpas; nada muda de comportamento.

### Fase 1 — Pessoa + CPF na aceitação (Q4-anterior, Q4-CPF)
- Ativação de convite (`/api/ativar`) e criação de unidade avulsa passam a **exigir
  CPF**; `find-or-create` de `persons` por (tipo, valor) e liga `users.person_id`.
- **Arquivos:** `lib/invites.js` (activate), `routes/units.js` (criar unidade avulsa),
  `static/ativar.html` (campo CPF), nova `lib/persons.js`.
- **Teste:** aceitar dois convites com o mesmo CPF em e-mails diferentes → um `person`,
  dois `users`.

### Fase 2 — Broker de autenticação + IdP de mentira (Q3-anterior)
- `lib/authBroker.js`: normaliza qualquer provedor para `{provider, subject, email}`.
- Provedor `kind='mock'` (só em dev): tela stub "entrar como Fulano" que devolve um
  subject — simula o redirect-and-return sem SSO real. `provisionFederatedUser` já
  grava em `user_identities`; passa pelo broker.
- **Teste:** um tenant de teste configurado com o provedor mock autentica ponta a ponta.

### Fase 3 — Filtro provedor-aceito na sessão (núcleo da Q2)
- A sessão passa a registrar **qual provedor** autenticou. `resolveContexts` /
  `/api/my-units` / `/admin/units/:id/works` filtram os memberships por
  `unit_auth_policies` (a unidade aceita o provedor usado?).
- Default de policies: unidades avulsas aceitam realm aberto (local/Google); unidades
  de tenant aceitam o provedor do tenant.
- **Teste:** mesmo user com identidade local + mock-SSO vê conjuntos diferentes de
  unidades conforme a porta.

### Fase 4 — Duas portas
- **Porta do tenant** `GET /:slug`: página com marca do tenant (branding_json) e os
  provedores dele (via broker/mock). Rota parametrizada, config por dado.
- **Porta genérica:** na falha do login aberto, extrai domínio → `auth_domains` →
  sugere "entrar por /slug".
- **Arquivos:** `routes/static.js` (`/:slug`), `static/tenant-login.html`,
  `static/login.html` (sugestão na falha), `routes/authFederated.js` (generalização).
- **Teste:** login por `/fgv` (mock) mostra só unidades FGV; `@fgv.br` na porta
  genérica cai no aberto e, se falhar, sugere `/fgv`.

### Fase 5 — Telas de administração de tenant (equipe ORATIA)
- Admin global cria/edita tenant (slug, branding), provedores (mock/OIDC/SAML +
  metadados), domínios associados, e os provedores aceitos por unidade.
- **Arquivos:** aba nova no `/admin` ou página `static/tenants.html`; rotas
  `/admin/tenants*` (requireAdmin = admin_global).
- **Teste:** provisionar um tenant fim-a-fim pela UI, sem tocar em SQL.

### Depois do piloto (fora deste plano)
- Adaptador **OIDC real** (generaliza o do Google) e **SAML via serviço** (WorkOS/
  Keycloak) por trás do broker.
- Provedores abertos extras (Microsoft pessoal, Apple) — linhas + adaptador.
- Tipos de identificador de estrangeiro em `civil_id_types`.

## Riscos e notas permanentes

- **Publish do Replit não propaga mudança de constraint por nome** → toda enumeração
  nova (tipos de identificador, kinds de provedor) vai em tabela-lookup + FK, nunca em
  `CHECK` de string. Ver `docs/access-model.md`.
- **Segredos por tenant** (client secrets, metadata SAML) ficam em env/cofre, nunca em
  `config_json`.
- **LGPD:** CPF é dado pessoal; a coleta na aceitação do vínculo tem base no
  consentimento do relacionamento — registrar isso na história de privacidade.
- **`one open identity per email`:** no realm aberto, no máximo uma identidade por user
  (local XOR Google) — índice parcial em `user_identities` + guarda no broker.
- **Coexistência com token de envio (contingência da Q1):** o caminho `/s/:token`
  (`requireSubmissionToken`, sem sessão) NÃO pode ser bloqueado pelo gating
  institucional — um trabalho num tenant SSO-only tem de continuar acessível pelo token
  que o professor envia. Verificar isto ao fechar as Fases 3 e 4 (teste: trabalho em
  unidade SSO-only abre por `/s/:token` sem login).
- **Ordem de execução:** Fase 0 → 1 → 2 → 3 → 4 → 5. A 2 (mock) precede a 3/4 para
  permitir teste ponta a ponta antes de qualquer SSO real.

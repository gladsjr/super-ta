# METAS do ORATIA

Base normativa do produto: é contra isto, junto com os princípios e o roadmap
da skill `oratia-improve`, que o `oratia-revisor` julga se uma entrega serve ao
que se pretende — e não apenas se está tecnicamente correta.

**Meta não é frente de roadmap.** A frente diz *o que construir*; a meta diz
*para que* e *como se sabe que deu certo*. Uma entrega pode cumprir a frente
perfeitamente e não mover meta alguma — e é justamente isso que a revisão deve
ser capaz de apontar.

## Como o revisor usa este arquivo

Os graus e o que reprova estão no `PRIMER.md`, que é a fonte — este arquivo não
cria critério próprio. O que ele determina é **o que conta como meta**:

- **Meta declarada** é critério, e entra na classificação do primer como "meta
  declarada".
- **Meta marcada `POR DECLARAR` não é critério.** O revisor **não reprova** por
  ela.
- **Meta nenhuma cobre o caso?** Julgue pelos princípios inegociáveis, pelas
  ADRs e pelo objetivo declarado da própria entrega. Não invente meta para
  reprovar.

Este arquivo é **do usuário**. Um agente propõe redação e traz evidência; quem
declara, altera ou remove meta é o usuário.

### Origem

As metas abaixo vêm do documento arquitetural **`Oratia-Arquitetura-v2.pdf`,
versão 1.4 (julho de 2026)** — roadmap de 12 frentes, riscos e a recomendação de
staging —, confrontado com o estado verificado do código em 31/08/2026.

**O PDF é material de referência externo e não é versionado neste
repositório**: o que dele precisa durar está aqui e no `oratia-improve`. A
versão fica registrada porque é a única âncora possível — chegando uma 1.5,
é por ela que se sabe o que já foi absorvido.

O documento é **anterior** a boa parte do que já está entregue. Toda afirmação
dele sobre o estado do produto foi conferida no código antes de virar meta; onde
divergiu, o código venceu.

O que o documento propõe e **já está entregue** não virou meta — está na seção
*Alcançadas*, para não ser reproposto.

---

## Metas declaradas

### M-01 — O professor gera a avaliação a partir do material da disciplina

- **Objetivo**: o professor sobe o material da disciplina e obtém atividades de
  avaliação geradas a partir dele, evoluindo para assistente de planejamento.
- **Por quê**: é a única frente que o documento arquitetural marca como **alta
  prioridade**, e é a parte dela que **de fato não existe**: não há upload de
  material da disciplina (o `docs/super-orchestrator-plan.md` o menciona como
  FUTURO). Hoje o professor parte do enunciado de uma atividade que ele já
  escreveu.
- **Como se mede**: o professor sobe material da disciplina e recebe atividades
  de avaliação derivadas dele, que pode aceitar ou ajustar — sem redigir o
  enunciado do zero.
- **Frentes relacionadas**: 1.
- **Estado**: ativa.

> **Não confundir com o que já existe**, sob pena de mandar reconstruir: a
> configuração do arguidor **já** tem modo Simples como padrão — galeria de
> personas, sem YAML (`static/professor.html`), com o editor YAML em modo
> avançado opt-in —, existe assistente conversacional de configuração
> (`ConfigAssistantAgent`) e a checagem mínima do enunciado roda automática no
> upload (`EnunciadoCoherenceAgent`). E atenção: o avaliador **qualitativo** de
> enunciado foi **removido de propósito** (issue #133, decisão de 06/08/2026)
> porque induzia o professor a consertar o que não era problema. Esta meta
> **não** pede que ele volte.

### M-02 — Carga e segurança são testadas fora de produção

- **Objetivo**: existir um ambiente indistinguível de produção onde teste de
  carga e de segurança rodem sem risco para aluno nenhum.
- **Por quê**: o ambiente de desenvolvimento não é representativo, e testar em
  produção é inaceitável. Sem isso, as metas M-03 e M-05 não têm onde rodar, e
  os limites da infraestrutura seguem desconhecidos.
- **Como se mede**: o ambiente tem VM de mesmo tamanho e região, banco
  próprio, chave de API própria e massa **sintética** — nunca cópia de dados de
  aluno. Nele roda um teste de carga de **pelo menos 30 entrevistas
  simultâneas** em modo mock, para medir o servidor sem custo de IA, e uma
  amostra menor em modo real. Produção não é afetada em nenhum dos dois.
  *O limiar de 30 é uma escolha nossa, para dar à meta um alvo verificável: o
  documento arquitetural não registra pico de simultaneidade — só os totais
  cumulativos do piloto (28 trabalhos, 128 submissões, 49 entrevistas, 2 provas
  orais). Ajuste quando houver medição real de pico.*
- **Frentes relacionadas**: 8, 10, 11.
- **Estado**: ativa.

### M-03 — Prompt injection é barrado por teste, não por esperança

- **Objetivo**: injeção direta e indireta cobertas por bateria formal que roda
  sozinha.
- **Por quê**: o documento aponta a injeção **indireta** como o vetor mais
  relevante — PDFs de aluno e enunciados entram no contexto dos agentes, e um
  documento adversarial pode tentar manipular o entrevistador ou o avaliador.
  Há a fronteira de confiança em `lib/agentPreamble.js`, mas nenhum teste
  sistemático que prove que ela aguenta. O documento registra ainda fragilidade
  comportamental observada: o entrevistador pode facilitar demais sob
  insistência do aluno.
- **Como se mede**: existe suíte que exercita injeção direta (na conversa) e
  indireta (via documento submetido), e ela **falha** quando um agente obedece
  instrução vinda de dado. Roda a cada mudança de prompt ou de agente.
- **Frentes relacionadas**: 8.
- **Estado**: ativa.

### M-04 — Degradação é percebida antes do usuário reclamar

- **Objetivo**: os sinais de saúde do sistema medidos, com alerta automático.
- **Por quê**: hoje os logs são locais ao processo, sem centralização nem
  alerta (`lib/logger.js` é console puro), e a detecção de abuso é reativa. Há
  superfície de medição a **estender**, não a criar: existe dashboard de
  Operações (`lib/opsStats.js`, alunos ativos e memória), fotografia da fila de
  jobs e teto de custo por trabalho verificado antes de gastar. O documento
  arquitetural lista **oito** sinais concretos — falha de TTS, queda do relay
  Realtime, custo por turno e orçamento por trabalho, latência do Realtime por
  região, acionamento do gate de inteligibilidade, falha de proctoring, 5xx e
  rate-limit da OpenAI, e falha de retomada de sessão após deploy.
- **Como se mede**: cada um dos oito sinais tem medição e limite de alerta; uma
  degradação em qualquer deles gera aviso sem depender de alguém abrir log.
- **Frentes relacionadas**: 9.
- **Estado**: ativa.

### M-05 — Nada chega à `main` sem bateria automática

- **Objetivo**: regressão detectada por máquina antes da integração.
- **Por quê**: **não existe CI em nenhuma branch** — verificado. Os testes
  existem em quantidade (mais de vinte alvos `npm run test:*`) mas rodam quando
  alguém lembra, e os que gastam API rodam manualmente. Uma regressão em prompt
  ou em cadeia de voz só aparece em uso.
- **Como se mede**: os testes que não gastam API rodam automaticamente a cada
  PR e bloqueiam a integração ao falhar. Os que gastam API têm gatilho
  explícito e teto de custo.
- **Frentes relacionadas**: 10.
- **Estado**: ativa.

### M-06 — Mídia de aluno tem retenção declarada e acesso auditável

- **Objetivo**: política formal de retenção e eliminação de áudio e vídeo, com
  trilha de quem acessou.
- **Por quê**: o áudio já tem prazo declarado e aplicável — **180 dias após
  `completed_at`** (`scripts/audio-gc.mjs`) — e o aluno acessa o próprio áudio.
  O que falta é de três ordens: (a) **o vídeo não tem retenção nenhuma** —
  verificado: `deleteAllForSubmission` apaga só o prefixo `audio/{token}/`
  (`lib/audioStore.js`), e o vídeo vive em **três** prefixos, todos fora do
  alcance dele e todos com chave *plana* — `prefixo/{token}-{timestamp}.{ext}`
  para as partes e `oral-video/{token}-consolidated-{n}.webm` para a gravação
  consolidada da prova oral (`lib/videoConsolidate.js`), que **não** tem
  timestamp; nenhuma delas usa `prefixo/{token}/…` como o áudio, o que muda como
  um GC por prefixo casaria o token: `oral-video/` da prova oral
  (`routes/oralExam.js`, `lib/videoConsolidate.js`), `proctor-video/` da
  fiscalização da entrevista (`routes/interview.js`) e `live-video/` da
  entrevista ao vivo (`routes/interviewLive.js`);
  (b) a execução do GC não é agendada, depende de alguém rodar; (c) não há
  trilha de auditoria de quem acessou mídia de aluno. A fiscalização por vídeo
  ampliou justamente a coleta que não tem prazo.
- **Como se mede**: o vídeo tem prazo e o GC o elimina; o GC roda agendado, sem
  depender de execução manual; e todo acesso a mídia de aluno fica registrado
  com autor e momento.
- **Frentes relacionadas**: 8.
- **Estado**: ativa.

### M-07 — Duas instâncias podem atender a mesma turma

- **Objetivo**: remover o que prende a sessão de um aluno a uma instância
  específica do servidor, **começando pela entrevista na variante de
  mensagens**. Os fluxos de voz ficam para depois, e não por esquecimento: dois
  dos três impedimentos vivem lá, protegidos por decisão (ver as colisões
  abaixo). Ampliar o escopo para a voz é meta nova, não extensão desta.
- **Por quê**: hoje só se escala verticalmente, e pico de turma inteira só se
  atende com VM maior. Verificado o que impede a réplica: `SESSIONS = new Map()`
  em `lib/sessionLifecycle.js`, cache de TTS em memória e conexões
  WebSocket/SSE vivas.
  **Note o que já está resolvido e não é justificativa desta meta**: a
  entrevista por mensagens sobrevive a restart, porque cada turno grava snapshot
  atômico em `submissions.runtime_state_json` e há rehidratação (princípio
  inegociável 6 — "não quebrar a rehidratação"). O que a instância leva consigo é
  o cache de TTS e a conexão viva.
  Nos fluxos de **voz** a situação é outra, e não é ausência de mecanismo:
  conferido em `lib/resumeGate.js`, existe caminho de retomada — ele decide
  `wouldResume` a partir da fala do aluno registrada em
  `oral_voice_json.student_speech_events` — e esse caminho é
  **deliberadamente barrado** (`RESUME_BLOCKED`) até a liberação do professor,
  pela ADR 0020. Não há o que "consertar" ali: há uma decisão a respeitar.
- **Como se mede**: com duas instâncias atrás de um balanceador, uma entrevista
  **na variante de mensagens** continua sem exigir que o aluno reenvie o turno
  corrente nem repita a resposta quando a instância que o atendia sai do ar. É
  onde o alvo é alcançável sem tocar em decisão travada, porque a rehidratação
  por snapshot já existe ali. **Os fluxos de voz ficam fora desta medida** — ver
  a colisão abaixo.
- **Frentes relacionadas**: 11.
- **Estado**: ativa.

> **Colisões declaradas — três, e nenhuma esta meta autoriza atravessar.**
>
> 1. **Cache de TTS em memória** — é o princípio inegociável 4 (*"TTS não é
>    persistido: LRU em memória, decisão de produto antiplágio"*). Um cache
>    compartilhado **não durável**, ou nenhum cache, cumprem a meta sem violá-lo.
> 2. **Relay WebSocket da prova oral** — escolhido de propósito em vez de
>    WebRTC (chave fora do navegador, medição autoritativa de custo, servidor no
>    laço para guardrails e gabarito). Não reprojete o relay por esta meta.
> 3. **O portão de retomada de sessão de voz** — e esta é a mais fácil de
>    atropelar, porque parece ser exatamente o que a meta pede. A **ADR 0020**
>    está entre as decisões travadas do `AGENTS.md`: queda de gravação pausa na
>    primeira, e a retomada **exige liberação do professor**, consumida a cada
>    uso. `lib/resumeGate.js` é a fonte única dessa decisão e vale para os
>    **dois** fluxos de voz — prova oral **e entrevista na variante realtime** —
>    porque a retomada automática produzia vídeo fragmentado e silencioso, e com
>    a ADR 0005 o vídeo é bloqueante. **Failover automático em fluxo de voz é
>    falhar em aberto**: é por isso que a medida acima se restringe à variante de
>    mensagens.
>
> Mexer em qualquer das três exige ADR nova no tronco, antes do código.

### M-08 — Um trabalho pode ser conduzido em outro idioma

- **Objetivo**: idioma definido por trabalho, com default vindo do ambiente do
  professor.
- **Por quê**: há issues abertas no tronco sobre isso, e uma delas registra, já
  no título, que o acoplamento ao português está na **lógica**, não só nas telas
  — o que significa que traduzir a interface não resolve. *Conferido por título
  na listagem de issues abertas em 31/08/2026, não por leitura integral: o
  backlog não tem cópia local, por desenho.*
- **Como se mede**: um trabalho configurado em inglês conduz entrevista,
  avaliação e devolutiva em inglês, sem português residual em nenhum texto
  gerado pelo modelo nem em mensagem de sistema vista pelo aluno.
- **Frentes relacionadas**: — (issues do tronco sobre idioma).
- **Estado**: ativa.

### M-09 — Arquivo submetido é verificado antes de ser processado

- **Objetivo**: ponto único de validação por onde todo upload passa, antes de
  chegar a qualquer processamento.
- **Por quê**: verificado — não há `fileFilter` central; a validação é ad-hoc
  por handler, e não há verificação antimalware. PDFs e vídeos de aluno seguem
  para serviços externos e para visão local sem inspeção comum.
- **Como se mede**: existe um ponto único que todo upload atravessa, validando
  tipo, tamanho e conteúdo; um arquivo malicioso conhecido é recusado antes de
  ser processado ou encaminhado.
- **Frentes relacionadas**: 8.
- **Estado**: ativa.

### M-10 — A instituição usa o provedor de identidade que já tem

- **Objetivo**: login federado além do Google, para que a instituição não seja
  obrigada a criar contas locais nem a adotar um provedor que não usa.
- **Por quê**: o Google OIDC está entregue (`routes/authFederated.js`), e o
  documento arquitetural pede também Microsoft e Apple — que **não existem**
  (verificado). Instituição em Microsoft Entra hoje só entra por conta local, e
  conta local é justamente o que a camada institucional quer eliminar.
  **O que falta é o handler, não a modelagem**: `lib/tenants.js` filtra os kinds
  a `local/google/mock` justamente porque `oidc` e `saml` têm "schema pronto,
  runtime ausente" (issue #149) — anunciar a porta sem o handler tornaria o
  login impossível ao clicar.
- **Como se mede**: um usuário de instituição que usa Microsoft Entra entra sem
  que exista senha local para ele, e o vínculo com a pessoa é o mesmo do fluxo
  Google — sem duplicar cadastro.
- **Frentes relacionadas**: 3.
- **Estado**: ativa.

### M-11 — Cenários deixam de ser experimentais, e vídeo cobre as três modalidades

- **Objetivo**: a modalidade de cenários multi-interação apta a uso real, e a
  fiscalização por vídeo disponível nas três modalidades — que são
  `interview`, `oral_realtime` e `scenario` (`works.kind`, migration 031).
- **Por quê**: o `replit.md` do tronco declara cenários **experimental**, o que
  na prática os mantém fora do que se oferece a uma turma. E a fiscalização,
  onde está ligada, é bloqueante por decisão (ADR 0005) — cobertura desigual
  entre modalidades significa que a escolha da modalidade decide o rigor
  possível.
  **A lacuna concreta é `scenario`**: verificado que ele não aparece em
  `videoMandatory` (`lib/proctor.js`) e que `docs/scenarios.md` não menciona
  vídeo. Cuidado ao cruzar com a ADR 0005: os "três **fluxos**" dela são
  entrevista por mensagem, entrevista realtime e prova oral — conjunto diferente
  das três **modalidades** desta meta. Ler um pelo outro faz a meta parecer
  alcançada.
- **Como se mede**: um professor conduz um cenário com turma real sem ressalva
  de experimental em tela ou documentação; e as três modalidades aceitam ligar
  fiscalização por vídeo, com o mesmo gate bloqueante.
- **Frentes relacionadas**: 4.
- **Estado**: ativa.

### M-12 — A instituição integra turma e nota sem digitar

- **Objetivo**: API que permita a um sistema de gestão educacional ou LMS criar
  turmas e receber notas.
- **Por quê**: a camada institucional existe no banco, mas o caminho de entrada
  é a interface — alguém digita. Numa instituição com muitas turmas, isso é o
  que impede a adoção, não a falta de recurso pedagógico.
- **Como se mede**: um sistema externo **cria** uma turma com seus alunos, por
  API autenticada, sem que ninguém preencha tela. *A leitura de notas já é
  possível hoje* — `POST /api/analytics/query` com token de análise tem consulta
  `grade_distribution` sobre `s.grade_final` —, então o alvo real desta meta é a
  escrita: criar turma, matricular, receber o vínculo.
- **Frentes relacionadas**: 5.
- **Estado**: ativa.

### M-13 — O aluno vê a marca da sua instituição

- **Objetivo**: identidade visual por unidade — logo, cores, layout.
- **Por quê**: **existe base, e ela é por unidade** — a migration 069 cria
  `tenants` chaveada pela unidade-raiz, com `branding_json` e o comentário
  explícito de que serve "a marca visual"; há escrita por admin
  (`routes/tenantsAdmin.js`), leitura (`lib/tenants.js`) e um consumidor em tela
  (`static/tenant-login.html`, cor de acento). O que **falta** é alcance: a
  marca aparece na porta de entrada do tenant, não nas telas do aluno e do
  professor. Para uma instituição que apresenta o sistema como serviço próprio,
  a marca alheia na tela do aluno é obstáculo de adoção, não detalhe estético.
- **Como se mede**: alunos de duas unidades distintas veem, na mesma
  instalação e **nas telas de trabalho** (não só na porta de login), as marcas
  das respectivas instituições — sem que uma veja a outra. Reusando
  `tenants.branding_json`, não um mecanismo novo.
- **Frentes relacionadas**: 6.
- **Estado**: ativa.

### M-14 — A área do professor é protegida como a do administrador

- **Objetivo**: fechar a assimetria de proteção entre o cockpit do professor e
  as áreas administrativas.
- **Por quê**: registrado nos débitos conhecidos e confirmado no código — o
  cockpit é protegido **só** por capability URL. Verificado: o token vem de
  `crypto.randomBytes(6)`, ou seja **48 bits**; `requireWorkToken`
  (`lib/middleware.js`) não consulta sessão; e **nenhum dos três** rate-limiters
  do servidor alcança o cockpit — `loginLimiter` cobre `POST /login`
  (`server.js`), `activationLimiter` cobre a ativação (`routes/activation.js`) e
  há um em `routes/analytics.js`. Quem tem o link é o
  professor, para todos os efeitos. As áreas de admin exigem sessão; a do
  professor, não.
- **Como se mede**: abrir o cockpit exige sessão autenticada com papel na
  unidade; o link sozinho não dá acesso; e há limite de tentativas por origem.
  Um link vazado deixa de ser credencial.
- **Frentes relacionadas**: 8.
- **Estado**: ativa.

---

## Alcançadas — não repropor

Ficam registradas para que o documento arquitetural, que é anterior, não leve
ninguém a reconstruí-las.

**A fonte do estado de cada frente é o roadmap na skill `oratia-improve`**; esta
tabela é derivada, e existe para o recorte de "o que já não é meta". Divergindo
das duas, o roadmap manda — e corrija esta.

| Meta / frente | O que existe | Evidência |
|---|---|---|
| Modelo institucional (frente 2) — **em grande parte**, com resto a confirmar | Unidades em árvore com flag de turma, 4 papéis, memberships, tenants, convites, pacotes e cotas | **16 tabelas** criadas pelas migrations 055–069 (contadas por `CREATE TABLE`); RBAC decidindo de fato — criar trabalho sem unidade exige `admin_global`. O roadmap registra que falta confirmar o que resta da frente |
| Benchmark contínuo de modelos (frente 7) | Harness de comparação com resultado portátil | `lib/bench/`, `config/benchmark.yaml`, `npm run bench`, migrations 042–044, ADR 0013 |
| Login federado (frente 3) — **entregue como opcional**; federação além do Google não | Google OIDC, convivendo com login local e capability URLs | `routes/authFederated.js`, tabelas `auth_providers` e `user_identities`, migration 066. **Microsoft e Apple não existem** — ver meta M-10 |
| Fila para a análise de vídeo (risco de escala) — **parcial** | Lane `video_analysis` na tabela `jobs`, com claim atômico e janela ociosa | `lib/proctorQueue.js`, migrations 078–079. **Mitigado, não extraído**: o `jobRunner` declara que "o app é o próprio worker" — segue na mesma VM |
| Chave de API separada por uso — **parcial** | Chave dedicada de benchmark, isolando o gasto | `OPENAI_API_KEY_BENCHMARK`, `lib/bench/adapters/openai.js` (fail-fast, sem fallback). **Não há separação por ambiente** |

O documento arquitetural também lista o papel **"funcionário"** na frente 2; ele
não existe no schema, que tem `admin_global`, `admin_unidade`, `professor` e
`aluno`. Divergência do documento, não lacuna do código.

---

## Candidatas — POR DECLARAR

> Nenhuma. Todas as candidatas levantadas do documento arquitetural foram
> promovidas a meta declarada ou movidas para *Alcançadas*.

Aparecendo candidata nova, ela entra aqui **sem valer como critério** até o
usuário a promover — e ganha identificador novo, nunca um aposentado (ver o
registro de mudanças).

## Registro de mudanças

Meta declarada, alterada ou removida deixa registro — o revisor precisa saber
contra qual versão julgou.

| Data | O quê | Por quê |
|---|---|---|
| 2026-08-30 | Arquivo criado, sem metas declaradas | O portão de revisão passou a exigir base normativa explícita; as metas não estavam registradas em lugar nenhum |
| 2026-08-31 | Nove metas declaradas (M-01 a M-09), cinco itens em *Alcançadas*, cinco candidatas | Extraídas do documento arquitetural v1.4 e confrontadas com o estado verificado do código. O que já está pronto foi separado para não ser reproposto. M-07, M-08 e M-09 promovidas de candidatas por decisão do usuário |
| 2026-08-31 | **Todas** as candidatas restantes promovidas a meta (M-10 a M-14), por decisão do usuário | Federação além do Google, cenários e vídeo nas três modalidades, integração com sistema de gestão, identidade visual por unidade e proteção do cockpit do professor. A lista de candidatas ficou vazia |
| 2026-08-31 | Identificadores de candidata **reatribuídos** | Ao promover três candidatas, as restantes foram renumeradas: o que era C-01 (idioma) virou M-08, C-02 (CI) foi absorvido por M-05, e o cockpit do professor saiu de C-03 para C-08. **Referência a "C-0N" anterior a esta data aponta para outro item.** Daqui em diante, identificador aposentado não é reutilizado |
| 2026-08-31 | M-13 reescrita depois de reprovada na revisão | A primeira redação afirmava que não havia marca por unidade. Existe base, e é por unidade: `tenants.branding_json` (migration 069, "a marca visual"), com escrita, leitura e um consumidor em tela. A busca inicial, em `lib/units.js` e `routes/units.js`, não alcançava esse caminho. A meta passou a pedir **alcance** — a marca chegar às telas de aluno e professor —, reusando o mecanismo existente |
| 2026-08-31 | M-01 reescrita depois de reprovada na revisão | A primeira redação afirmava que a preparação "exige entender a configuração do arguidor" — o código contradiz: o modo Simples sem YAML já é o padrão, há assistente de configuração e a checagem de enunciado já roda no upload. A medida original estava em parte cumprida, e "enunciado validado" apontava para uma validação qualitativa que o tronco **removeu de propósito**. A meta passou a cobrir só o que de fato falta: o caminho do material da disciplina |

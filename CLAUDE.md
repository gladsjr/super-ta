# CLAUDE.md — workspace de SDLC do ORATIA

Primeira leitura de qualquer sessão aberta aqui. Curto de propósito: o detalhe
vive nos artefatos apontados no fim.

## Fronteira do compartimento — inegociável

Esta máquina hospeda trabalho de organizações e clientes distintos. **Este
workspace é um compartimento estanque.**

- **Não traga nada de fora.** Nome de cliente, empresa, produto, repositório ou
  ferramenta de outro contexto; código, configuração ou processo alheio — **nem
  a menção de que existem**. Citar outro contexto já é o vazamento.
- **Não varra o disco** procurando contexto. Trabalhe dentro deste workspace.
  Precisando de algo fora dele, vá ao caminho específico.
- **Justifique toda decisão pelos fatos daqui.** "Vi funcionar em outro lugar"
  não é evidência. Sem base local suficiente, diga isso e pergunte.

Isto vale igualmente em sessão local, remota ou agendada.

## Onde você está

Dois repositórios independentes, um dentro do outro:

```
<raiz do workspace>/          branch `oratia-sdlc` — ferramental de SDLC
├── CLAUDE.md                 este arquivo
├── MANIFESTO.yaml            fonte da verdade do ambiente
├── INSTALACAO.md             roteiro de instalação e diagnóstico
├── docker-compose.yml        orquestra o ambiente (inclui o compose do tronco)
├── Dockerfile                imagem da aplicação
├── tools/                    ferramental executável
├── .claude/skills/           skills deste workspace
└── super-ta/                 TRONCO — clone independente, ignorado por esta branch
```

`oratia-sdlc` é uma **branch órfã**: não compartilha commit algum com as
branches de código. Não há merge possível entre as duas histórias, e nada daqui
aparece em PR de produto.

## Regras invioláveis

**Cada mudança pertence a um repositório só.** Mexeu em skill, manifesto,
roteiro, Dockerfile ou compose do workspace → commit **na raiz**. Mexeu em
código, migration, prompt ou teste da aplicação → commit **dentro de
`super-ta/`**, em branch de feature. Antes de commitar, confirme onde está:

```bash
git rev-parse --show-toplevel && git branch --show-current
```

**Verifique, não presuma.** Todo identificador de pacote, caminho, versão e
comando escrito num artefato tem de ter sido **executado** antes. Não podendo
executar, escreva que não verificou — o manifesto tem o campo `verificado` para
isso.

**Nada de conhecimento durável na memória do agente.** Ela não viaja entre
máquinas nem chega a outro colaborador. O que precisa durar vira artefato
versionado — a skill `oratia-conhecimento` diz qual.

**Segredo não entra no repositório.** Só o **nome** e de onde obtê-lo. Achou
segredo já commitado ou em URL de remote: **pare e avise o usuário** — trocar
não revoga.

**Sem caminho absoluto de máquina.** Caminhos são relativos à raiz do
workspace. O que é específico da máquina é gerado por script e ignorado pelo
git.

**Uma fonte da verdade por assunto.** Precisando um fato aparecer em dois
lugares, declare a fonte e registre a regra na *matriz de propagação* da skill
`oratia-ambiente`. Duplicata sem essa regra diverge em silêncio.

**Audite o índice antes de cada commit**, por tamanho e por padrão de segredo.
E confira `git config user.email`: o e-mail do ambiente da sessão pode ser de
outra organização, e cada commit o carimba.

## Como o ambiente sobe

Tudo em containers. No Windows, Docker sempre sobre **WSL2**.

```bash
node tools/verificar-prerequisitos.mjs
```

Zero bloqueios, siga o [INSTALACAO.md](INSTALACAO.md). O passo a passo canônico
está em `bootstrap:` no [MANIFESTO.yaml](MANIFESTO.yaml).

## Para onde ir

| Precisa de | Vá para |
|---|---|
| Montar em máquina nova, diagnosticar falha de ambiente | skill `oratia-ambiente` |
| Construir imagem, dependências, migrations | skill `oratia-build` |
| Subir e validar a aplicação | skill `oratia-deploy` |
| Contratos, topologia, credenciais de teste, decisões e porquês | skill `oratia-conhecimento` |
| Evoluir o código da aplicação | skill `oratia-improve` |
| Convenções do código (migrations, prompts, ADRs) | `super-ta/AGENTS.md` |

## Idioma

Responda em português brasileiro. Evite verbos aportuguesados de termos em
inglês ("deployar", "buildar", "commitar"). Termos técnicos consagrados
(commit, deploy, branch, container) podem ficar em inglês.

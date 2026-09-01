# PRIMER — conduta de trabalho no ORATIA

Carregado em toda sessão, junto do `CLAUDE.md`. Define **como se trabalha
aqui**: os dois ciclos, o que os separa, o que os liga, e o portão que toda
entrega atravessa.

## Dois ciclos, nunca misturados

|  | **Ciclo de produto** | **Ciclo de SDLC** |
|---|---|---|
| O que é | O que o ORATIA faz para professor e aluno | O que torna o ciclo de trabalho reprodutível |
| Exemplos | código, migration, prompt, agente, tela, teste da aplicação | primer, manifesto, roteiro, skill, Dockerfile, compose, ferramental |
| Repositório | `super-ta/` | raiz do workspace |
| Branch | **branch derivada de `main`** → PR → `main` | **direto em `oratia-sdlc`** |
| Fonte de convenções | `super-ta/AGENTS.md` e as ADRs | este primer e o `MANIFESTO.yaml` |

**`main` é a base de toda evolução de produto.** Nunca derive de `release` nem
commite direto em `main`. A integração é por PR.

**`oratia-sdlc` não tem branch de trabalho.** É branch órfã, sem PR e sem CI;
o portão de qualidade dela é a revisão independente, não o merge.

### Em qual ciclo estou?

Pergunta única: **um professor ou um aluno percebe essa mudança?**

- Sim → produto. Commit em `super-ta/`, em branch derivada de `main`.
- Não, mas muda como se monta, constrói, sobe ou diagnostica o ambiente →
  SDLC. Commit na raiz, em `oratia-sdlc`.

Antes de commitar, confirme onde está — o diretório decide o repositório:

```bash
git rev-parse --show-toplevel && git branch --show-current
```

Na dúvida entre os dois, **é produto**: o SDLC descreve o produto, então
mudança de produto costuma vir primeiro e puxar a do SDLC atrás.

## Propagação: produto → SDLC, na mesma entrega

**Mudança de produto que altera como o ambiente é montado, construído, subido
ou diagnosticado obriga a atualizar o SDLC.** Não é tarefa para depois: entrega
de produto que deixa o SDLC desatualizado está incompleta.

A razão é concreta, não teórica. O roadmap deste workspace afirmava *"hoje todo
usuário logado é admin — não há roles"* muito depois de a camada de papéis ter
sido entregue e estar em uso. Um agente lendo aquilo proporia construir o que já
existia. **SDLC desatualizado é pior que SDLC ausente**: ele mente com
autoridade.

Repare no limite desta regra: ela obriga quem passa **por aqui**. Mudança que
entra no tronco por fora deste workspace não é alcançada por ela — e foi
exatamente assim que a deriva acima aconteceu. Enquanto não houver conferência
periódica do SDLC contra o tronco, **desconfie de afirmação do SDLC sobre o
estado do produto**: confirme no código ou no banco antes de agir, e corrija o
artefato ao encontrar divergência.

Gatilhos — mudou no produto, atualize no SDLC:

| Mudou no produto | Atualize |
|---|---|
| Versão de runtime ou dependência de sistema | `Dockerfile`, `MANIFESTO.yaml` |
| Variável de ambiente obrigatória, nome de segredo | `MANIFESTO.yaml`, `.env.example`, `docker-compose.yml` |
| Rota de saúde, porta, topologia de serviço | `docker-compose.yml` (healthcheck), `INSTALACAO.md`, `MANIFESTO.yaml` |
| Comando de build, de migration, de teste | `oratia-build`, `INSTALACAO.md` |
| Serviço de infraestrutura novo | `docker-compose.yml`, `MANIFESTO.yaml`, `oratia-ambiente` |
| Semente de usuário, papel, credencial de teste | `INSTALACAO.md`, `oratia-deploy`, `oratia-conhecimento` |
| Frente do roadmap entregue ou abandonada | `oratia-improve` (roadmap), `METAS.md` |
| Armadilha operacional descoberta | `oratia-conhecimento` |

O fato aparece em mais de um arquivo? A **matriz de propagação** na skill
`oratia-ambiente` diz quem é a fonte e quem acompanha. Fato novo duplicado
ganha linha nova na matriz.

## Portão de revisão independente

**Todo plano e toda implementação passam por revisão de um agente independente
antes de serem dados por entregues.** O revisor é o subagente `oratia-revisor`;
o procedimento está na skill `oratia-revisao`.

### O que passa pelo portão

Exige revisão: **plano de trabalho**, mudança de **código**, **migration**,
**prompt**, **skill**, **manifesto**, **roteiro**, **primer**, **Dockerfile**,
**compose** e **ferramental**.

Isento — lista fechada, e é fechada de propósito, para não virar brecha:

1. correção de typo ou reformatação **sem efeito observável** em comportamento,
   instrução ou saída;
2. o registro da própria revisão.

Fora dessas duas, revisa. Na dúvida sobre estar isento, **não está**.

### Classificação e veredicto

Esta tabela é a **fonte**. O agente `oratia-revisor` e a skill `oratia-revisao`
a repetem para serem autossuficientes — mudou aqui, mudam os três na mesma
alteração (matriz de propagação em `oratia-ambiente`).

| Grau | Quando | Efeito |
|---|---|---|
| **BAIXO** | Melhoria desejável, que não compromete o objetivo nem contraria norma. Também: decisão tomada sem meta declarada que a cubra | Não reprova. Corrija se barato; registre se não |
| **MODERADO** | Contraria norma, meta declarada ou diretriz; deixa o objetivo parcialmente por cumprir; cria duplicata sem regra de propagação; afirma o que não foi verificado | **Reprova** |
| **CRÍTICO** | Viola invariante de segurança ou princípio inegociável; quebra o ambiente; produz dado incorreto; expõe segredo; commita no repositório ou na branch errados | **Reprova** |

Um único MODERADO ou CRÍTICO reprova a entrega e exige reformulação.

Classifique pelo **efeito**, não pelo esforço de corrigir. Meta marcada
`POR DECLARAR` em `METAS.md` **não é critério** e não reprova.

### O laço, e onde ele termina

Reprovou → reformule → submeta de novo. **Após a terceira reprovação, pare e
escale ao usuário**, apresentando: o apontamento que persiste, o que já foi
tentado, e sua leitura de onde está o problema — na entrega ou no critério.

Insistir além disso desperdiça a sessão e esconde o caso real: às vezes o
apontamento é que está calibrado errado, e só o usuário decide isso.

### Os dois modos de falha que o portão pega quase sempre

Levantado das entregas que atravessaram este portão até aqui: **quase todo**
apontamento de grau MODERADO caiu numa de duas classes, e nenhum deles foi
divergência de critério. É observação de uma amostra, não lei — e de propósito
não há log de revisões que a torne auditável depois (ver `oratia-revisao`).
Vale como heurística de quem submete, **não** como argumento para descartar
apontamento: quando o revisor sustentar que o critério é o problema, a cláusula
de escalonamento acima é que decide.

**1. Afirmei sem verificar.** O artefato diz um número, um caminho, uma
contagem ou uma causa que ninguém executou. Exemplos reais: "nove sinais" onde o
documento lista oito; "11 tabelas" onde são dezesseis; um prefixo de
armazenamento que não existe no código; uma estatística de pico que a fonte não
traz; e — o mais instrutivo — uma **causa inventada** para um sintoma real, que
sobreviveria como armadilha registrada se ninguém tivesse ido ao código.

*Antes de submeter:* releia o que escreveu procurando afirmação factual, e
pergunte de cada uma "de qual comando isso saiu?". Não tendo resposta, execute
ou marque como não verificado.

**2. Propaguei pela metade.** O fato foi corrigido num lugar e ficou velho em
outro. Isso é pior que não corrigir: o artefato passa a contradizer-se, e um
cabeçalho pode até garantir que a correção foi feita. Aconteceu com uma
contagem trocada em uma de três ocorrências, com uma regra ampliada numa linha
da matriz e não na vizinha, e com uma afirmação corrigida em dois de três
arquivos.

*Antes de submeter:* para cada fato que você mudou, pergunte **qual é o fato** e
**em quantos lugares ele está afirmado** — e procure por aí.

E cuidado com a armadilha desta varredura, que já custou três rodadas seguidas
numa entrega desta sessão: **o "valor antigo" não é a string que você editou.**
Grepar `três turnos` acha onde você escreveu isso; não acha `por transitividade`
nem `só isso prova`, que afirmam o **mesmo critério** com outras palavras. A
correção entra onde o código está e para antes dos artefatos que declaram o
contrato dele — manifesto, roteiro, skill. Liste os artefatos que afirmam o fato
**antes** de editar o primeiro deles.

E varra os arquivos **versionados** (`git ls-files`), não as pastas que você
lembra de ter mexido: numa entrega desta sessão a varredura cobriu as skills, os
artefatos de raiz e o script novo, e deixou `docs/` de fora por cinco rodadas —
era onde estavam dois dos apontamentos.

Um corolário que vale por si: **não use como fonte um artefato que você acabou
de marcar como envelhecido.** Se o SDLC diz algo sobre o estado do produto,
confirme no código antes de propagar — foi assim que uma nuance decisiva se
perdeu (um mecanismo que existia e era deliberadamente barrado virou "mecanismo
ausente" numa meta).

### O revisor não escreve

O `oratia-revisor` **não altera plano nem implementa código** — não tem
ferramenta de escrita. Ele julga contra o objetivo declarado e a base
normativa, e devolve apontamentos classificados. Quem corrige é quem executa.

Corolário para quem submete: **declare o objetivo antes de submeter.** Sem
objetivo declarado, o revisor não tem contra o que julgar, e a revisão vira
opinião.

## Toda atualização do SDLC respeita as diretrizes já estabelecidas

Mudar o ferramental não isenta das regras que ele próprio impõe. **As regras
invioláveis estão no `CLAUDE.md`** — carregado junto com este arquivo, e a
fonte delas. Não são repetidas aqui de propósito: duas cópias sempre carregadas
divergiriam sem que ninguém percebesse.

Duas valem lembrar por serem as mais esquecidas ao mexer no próprio ferramental:

- **Verifique, não presuma** — inclusive o que você acabou de escrever. Comando
  registrado num artefato precisa ter sido executado.
- **Uma fonte da verdade por assunto**, com a propagação registrada na matriz.

E acima de todas, a **fronteira do compartimento**.

## Base normativa

Contra o que uma entrega é julgada — nesta ordem, e sem duplicar nada:

| Assunto | Fonte |
|---|---|
| Conduta do ciclo, portão, propagação | este primer |
| Regras invioláveis e fronteira | `CLAUDE.md` |
| Metas do produto | `METAS.md` |
| Princípios inegociáveis, roadmap, débitos, matriz de validação | skill `oratia-improve` |
| Decisões travadas, invariantes de privacidade, convenções de código | `super-ta/AGENTS.md` e `super-ta/docs/decisoes/` |
| Backlog | **issues do repositório do tronco** — não há cópia aqui, e não deve haver |
| Ambiente: pré-requisitos, layout, segredos, bootstrap | `MANIFESTO.yaml` |
| Armadilhas operacionais já conhecidas | skill `oratia-conhecimento` |
| Matriz de propagação (fato em mais de um arquivo) | skill `oratia-ambiente` |

O backlog vive nas issues de propósito: uma cópia local divergiria no primeiro
dia, que é exatamente o modo de falha que a matriz de propagação existe para
impedir.

## Atualização do ferramental

No início da sessão, um hook consulta o remoto — no máximo uma vez a cada 24h —
e, com a árvore de arquivos rastreados limpa e o avanço sendo fast-forward,
aplica a atualização. Havendo trabalho local ou divergência, ele **avisa e não
toca em nada**, e não marca a verificação como feita: volta a avisar na sessão
seguinte, até resolver.

Quando o aviso disser que mudou **o que o agente lê como instrução**, releia
esses arquivos antes de agir pelo que você lembra deles. A lista do que conta
como instrução vive no próprio script, que é a fonte.

**Releitura não vale para tudo.** Subagente novo (`.claude/agents/`) demora a
ficar disponível — a descoberta é diferida, não instantânea. E um hook de
`SessionStart` declarado agora só roda na **próxima sessão**, porque o gancho
desta já passou (o que vale para outros tipos de hook não foi observado). O
script avisa quando a atualização mexe nesses caminhos. Detalhe, verificação e
contorno na skill `oratia-conhecimento`.

E note o que este mecanismo implica: o ferramental que chega **já executa**, sem
passar pelo portão de revisão desta máquina. O portão é do lado de quem
escreve, não de quem recebe. É consequência aceita de manter todos atualizados
automaticamente — e a razão de o repositório ser controlado pela organização.

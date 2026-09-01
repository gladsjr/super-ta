# Documentação do ORATIA

Este é o ponto de entrada. Cada pasta abaixo tem um **ciclo de vida diferente** —
essa é a regra que organiza tudo. Antes de criar um arquivo, decida a qual gênero
ele pertence; se não couber em nenhum, provavelmente não é documentação.

| Pasta | Gênero | Responde | Ciclo de vida |
|---|---|---|---|
| [`capacidades/`](capacidades/) | **O que o produto faz** | "Se eu mudar isso, o que é afetado?" | Vive enquanto a capacidade existir. Atualizada no mesmo PR que muda o comportamento. |
| raiz de `docs/` | **Referência de subsistema** | "Como isso funciona por dentro?" | Sempre reflete o código de hoje. Atualizada no mesmo PR que muda o código. |
| [`decisoes/`](decisoes/) | **Por que é assim** (ADR) | "Por que fizeram dessa forma?" | **Imutável.** Decisão nova supersede a antiga; nunca se edita uma ADR aceita. |
| [`historico/`](historico/) | **O que já foi** | "O que tentamos e o que medimos?" | **Congelado.** Datado no nome, nunca atualizado. |

O que **não** entra aqui: planos de trabalho em aberto (vivem em issues e na
descrição do PR) e artefatos de execução — transcrições de teste, saídas de
bench, relatórios gerados (`tests/`, `bench/`, `reports/`).

## Por onde começar

- **Entender o produto:** [`capacidades/`](capacidades/) — comece pelo índice.
- **Mexer no código:** [`architecture.md`](architecture.md) (ciclo `/chat` + mapa
  de prompts) e o [`AGENTS.md`](../AGENTS.md) na raiz (convenções obrigatórias).
- **Entender uma escolha estranha:** [`decisoes/`](decisoes/). Muita coisa que
  parece arbitrária tem motivo documentado — e algumas são armadilhas conhecidas.

## Referência de subsistema (nesta pasta)

| Arquivo | Cobre |
|---|---|
| [`architecture.md`](architecture.md) | Ciclo `/chat` e o mapa completo de prompts (diagrama Mermaid). Ponto único de descoberta de prompts. |
| [`super-orchestrator-plan.md`](super-orchestrator-plan.md) | Racional do orquestrador de turno e o schema da ação. |
| [`oral-exam.md`](oral-exam.md) | Prova oral: relay Realtime, encerramento garantido, portão de setup, calibração, proctoring, agentes e schema. |
| [`falhas-de-provedor.md`](falhas-de-provedor.md) | O que o aluno lê quando a OpenAI falha, e por que avaliação sem insumo completo não produz nota em silêncio. |
| [`video-proctoring.md`](video-proctoring.md) | Fiscalização por vídeo: áreas de comando, gate obrigatório em três camadas, liberação pelo professor. |
| [`access-model.md`](access-model.md) | Camada institucional: unidades, RBAC por unidade, identidade/SSO, portões de uso. |
| [`scenarios.md`](scenarios.md) | Cenários multiagente (experimental). |

## Convenções

**Idioma.** Documentação funcional (`capacidades/`) e decisões (`decisoes/`) em
**português** — o público é a equipe e o negócio. A referência de subsistema está
majoritariamente em inglês por herança; ao reescrever um trecho grande, pode
migrar para português, mas não faça tradução de arquivo inteiro só por fazer.

**Formato.** Markdown é a fonte, sempre. Diagramas em Mermaid dentro do próprio
markdown (renderiza no GitHub e no site; a IA lê como texto). Não versionar
diagrama como imagem sem a fonte junto.

**Site para humanos.** `mkdocs.yml` na raiz gera o site navegável a partir destes
mesmos arquivos (`mkdocs serve` para ver local). Nunca mantenha uma segunda
fonte em HTML ou PDF: PDF só para documento que precisa congelar (proposta,
contrato, apresentação), e esses vivem fora do repositório.

**Índice para agentes.** [`llms.txt`](../llms.txt) na raiz lista o que existe e
para que serve, no formato que os agentes esperam. Ao criar ou remover um
documento importante, atualize-o na mesma mudança.

**Estado no topo.** Todo documento de capacidade começa com uma linha de estado
(`em produção` · `em revisão` · `experimental`) e a data da última revisão. Sem
isso, o leitor não sabe se está lendo o sistema de hoje.

# Decisões de arquitetura (ADR)

Uma decisão por arquivo, numerada e **imutável**. Quando uma decisão muda, não se
edita a antiga: cria-se uma nova que a supersede, e a antiga ganha o estado
`Superada por NNNN`. É isso que preserva o "por que era assim antes", que é
justamente o que se perde quando a documentação é reescrita.

## Quando escrever uma ADR

Quando a escolha tem **consequência** e alguém razoável poderia fazer diferente:
uma restrição que parecerá arbitrária daqui a seis meses, uma armadilha
descoberta na prática, um caminho abandonado depois de tentar. Se a resposta a
"por que não do jeito óbvio?" leva mais de uma frase, vira ADR.

Não vira ADR: convenção de estilo, escolha sem alternativa real, detalhe que o
código já explica sozinho.

## Índice

| # | Decisão | Estado |
|---|---|---|
| [0001](0001-migrations-nao-rodam-no-boot.md) | Migrations não rodam no boot | Aceita |
| [0002](0002-falhar-explicito-sem-fallback.md) | Falhar explícito, sem fallback arquitetural | Aceita |
| [0003](0003-analise-sempre-em-texto.md) | Análise sempre em texto; áudio é última milha | Aceita |
| [0004](0004-proctoring-nao-acusa-automaticamente.md) | Fiscalização não acusa nem penaliza automaticamente | Aceita |
| [0005](0005-video-obrigatorio-e-bloqueante.md) | Vídeo obrigatório e bloqueante nos três fluxos | Aceita |
| [0006](0006-um-raciocinio-por-turno.md) | Um raciocínio por turno, guardas no código | Aceita |
| [0007](0007-gabarito-nunca-sai-do-servidor.md) | O gabarito nunca sai do servidor | Aceita |
| [0008](0008-voz-realtime-nao-e-mais-barata.md) | Voz em tempo real não é mais barata que mensagens | Aceita |
| [0009](0009-nota-e-devolutiva-publicam-separado.md) | Nota e devolutiva têm publicações independentes | Aceita (entrevista) · superada por 0012 na prova oral |
| [0010](0010-config-nao-vai-crua-ao-modelo.md) | Configuração nunca vai crua ao modelo | Aceita |
| [0011](0011-enumeracoes-em-tabela.md) | Enumerações que evoluem vão em tabela, não em CHECK | Aceita |
| [0012](0012-publicacao-conjunta-na-prova-oral.md) | Na prova oral, nota e devolutiva publicam juntas | Aceita |
| [0013](0013-resultados-de-benchmark-sao-portaveis.md) | Resultados de benchmark são portáveis entre ambientes | Aceita |
| [0014](0014-analytics-consulta-tabelas-base.md) | O endpoint de análise consulta tabelas-base, não views | Aceita |
| [0015](0015-devolutiva-uniforme-na-turma.md) | O formato da devolutiva é uniforme na turma | Aceita |
| [0016](0016-turno-e-pergunta-do-plano.md) | Na entrevista em tempo real, turno é pergunta do plano | Aceita |
| [0017](0017-triagem-humana-da-fiscalizacao.md) | A triagem da fiscalização é humana e alimenta o pipeline | Aceita |
| [0018](0018-limiar-destaca-nao-oculta.md) | O limiar destaca, não oculta; celular mede segundos | Aceita |
| [0019](0019-lote-avalia-quem-concluiu.md) | O lote avalia quem concluiu; o resto é individual | Aceita |
| [0020](0020-queda-de-gravacao-pausa-na-primeira.md) | Queda de gravação pausa na primeira; retomada exige liberação | Aceita |
| [0021](0021-vigilancia-fala-pela-interface.md) | Vigilância ao vivo fala pela interface; gravação > detecção | Aceita |

Use o [modelo](template.md) para criar a próxima.

## Colisão de número entre branches

Duas branches podem criar a `NNNN` ao mesmo tempo — já aconteceu com a 0012.
Regra igual à das migrations: **se a `main` já tem esse número, renumere a sua**
antes de integrar, e corrija o título dentro do arquivo e as referências que
apontam para ele. Quem chega depois renumera.

Vale conferir também se a ADR que chegou primeiro **supersede** alguma antiga: em
caso afirmativo, o estado da antiga muda no índice e as páginas de capacidade que
a citavam precisam ganhar a ressalva.

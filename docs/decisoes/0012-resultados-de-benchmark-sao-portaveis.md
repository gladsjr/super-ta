# 0012 — Resultados de benchmark são portáveis entre ambientes

> **Estado:** Aceita
> **Data:** 2026-07 (registrada em 2026-08-15)

## Contexto

O benchmark grava seus resultados no Postgres local de quem o rodou. Mas o que
se está medindo são **os modelos**, não a máquina — e a comparação só tem valor
se um resultado levantado num ambiente puder ser lido, conferido e comparado em
outro. Preso ao banco local, cada rodada viraria um número solto que ninguém
mais consegue auditar.

## Decisão

Existe um pacote portátil de exportação e importação com identificação de tipo e
versão de schema próprios. Ele leva o necessário para reconstruir os resultados
no destino: versões de setup (com o manifesto dos casos congelados), versões de
júri, releases e as execuções completas com seus filhos — saídas, julgamentos,
consenso e ledger de custo. Colunas de identidade local (quem publicou, qual
chave gerou, qual diretório de artefato) são **zeradas na importação**, porque
não existem no destino.

## Consequências

- Um resultado só é comparável a outro **dentro do mesmo par setup + júri**. Isso
  é uma restrição real: mudou o banco de casos ou o critério de julgamento,
  perdeu-se a comparabilidade com o histórico.
- O formato do pacote passa a ser um contrato: mudá-lo exige versionar, sob pena
  de tornar ilegíveis os pacotes já exportados.
- Os casos carregam `schema_version` própria, separada da do pacote — as duas
  evoluem em ritmos diferentes.
- Custo: mais cerimônia para publicar um resultado do que simplesmente rodar e
  olhar. Aceito, porque resultado que não se pode auditar depois não decide nada.

# 0001 — Migrations não rodam no boot

> **Estado:** Aceita
> **Data:** 2026-06 (registrada em 2026-08-15)

## Contexto

O servidor rodava as migrations ao subir. O fluxo de **Publish** do Replit, porém,
aplica o diff de schema de dev para produção **sem registrar nada** na tabela de
controle de produção. Resultado: o boot de produção tentava reaplicar uma
migration que o Publish já tinha materializado e quebrava (`column already
exists`), travando o servidor a cada reinício até alguém corrigir o ledger na mão.

## Decisão

O boot **nunca** executa DDL. O ambiente de desenvolvimento evolui via o comando
de migração; produção é materializada pelo Publish. A tabela de controle é o
ledger do desenvolvimento — em produção ela existe, mas ninguém a lê no boot.

## Consequências

- Uma migration precisa estar **aplicada e testada em dev antes do Publish**,
  senão o diff não a leva para produção.
- Migration que falha em dev é bug bloqueante: corrigir antes de publicar.
- Perde-se a garantia de que "subiu, logo o schema está certo". Em compensação,
  o boot deixa de ser um ponto de falha.
- Não reverta isto sem ler o contexto: parece um descuido e não é.

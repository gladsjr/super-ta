⚠️ Você está mexendo em `migrations/`. Regras duras deste projeto (AGENTS.md):

1. **NUNCA edite uma migration já aplicada** em qualquer ambiente — nem um typo
   em comentário. Para corrigir, crie uma corretiva `NNN+1`. Editar uma que
   FALHOU (rollback, não registrada) é OK.
2. **O boot NÃO roda DDL.** Dev migra com `npm run db:migrate`; produção é
   materializada pelo Publish do Replit (diff dev→prod). Isso é decisão
   deliberada, não descuido — leia
   `docs/decisoes/0001-migrations-nao-rodam-no-boot.md` antes de propor rodar
   migration no boot.
3. A migration precisa estar **aplicada e testada em DEV antes do Publish**,
   senão o diff não a leva para produção.
4. Escreva SQL direto, **sem** `IF NOT EXISTS` nem guardas de idempotência
   (exceto `001_init.sql`, que é o snapshot de bootstrap).
5. **Colisão de números entre branches:** se a `main` já tem esse `NNN`,
   renumere a sua.
6. **Seeds são separados de migrations** e rodam depois delas (`auth.js`).
7. Enumeração que pode evoluir vai em **tabela + FK**, não em `CHECK` de strings
   — mudar a definição de um `CHECK` mantendo o nome NÃO propaga no Publish
   (`docs/decisoes/0011-enumeracoes-em-tabela.md`).

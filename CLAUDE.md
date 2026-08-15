# CLAUDE.md

As convenções deste projeto valem para **qualquer** agente e vivem num arquivo
só, no padrão aberto que os demais agentes também leem:

@AGENTS.md

Panorama do sistema: @replit.md

Não duplique aqui nada que esteja no `AGENTS.md` — este arquivo existe apenas
porque o Claude Code carrega `CLAUDE.md` por convenção própria. Se precisar
mudar uma convenção do projeto, mude no `AGENTS.md`.

## Específico do Claude Code

- **Skills** do projeto ficam em `.claude/skills/` (ex.: `testar-modo-audio`,
  que roda a entrevista por voz ponta a ponta no navegador).
- **Memória operacional** em `.agents/memory/`: lições de infraestrutura e
  armadilhas de ambiente descobertas na prática (Replit, Docker, binários
  nativos). São notas de campo, não decisões de arquitetura — decisão com
  consequência duradoura vira ADR em `docs/decisoes/`.
- Este clone (`super-ta-repo`) é o ambiente do Claude: banco `oratia_claude`,
  porta `:5000`. A tabela completa está no `AGENTS.md`.
- Se houver outra sessão do Claude no mesmo clone, **não troque de branch** —
  crie um worktree (`git worktree add`) para o trabalho paralelo.

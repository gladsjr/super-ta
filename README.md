# Super TA MVP

Este MVP expõe uma API Express para auxiliar monitores na análise de trabalhos enviados em PDF. O fluxo agora inclui ingestão completa do PDF (com fallback de OCR via modelo visão) e geração inicial de um roteiro de perguntas logo após o upload.

## Instalação

```bash
npm install
```

> ⚠️ Dependências como `canvas` exigem toolchains nativos. Em ambientes sem acesso ao registro npm, configure o proxy ou instale-as manualmente antes de rodar o servidor.

## Execução

```bash
npm run dev
```

O servidor sobe em `http://localhost:8000`.

## Teste manual realizado

1. Inicie o servidor (`npm run dev`).
2. Crie uma sessão com `POST /session` e capture o `session_id` retornado.
3. Faça upload de um PDF (até 30 páginas) usando `POST /upload?session=<session_id>` com o campo `file`.
4. Verifique a resposta do upload:
   - Deve retornar `{ ok: true, pages, ocr_used, generated, assistant }`.
   - Confirme que `data/submissions/<session_id>/submission.md` e `questions.json` foram gerados.
5. Consulte `GET /questions?session=<session_id>` para obter o JSON de perguntas iniciais.
6. Envie mensagens para `POST /chat?session=<session_id>` e confirme que o chat usa apenas o resumo (o texto completo não reaparece).

Esses passos validam a ingestão, a geração automática de perguntas e o uso do resumo no contexto do chat.

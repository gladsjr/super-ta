# Falhas de provedor — o que o aluno lê e o que a nota vale

> Referência técnica. Fonte da regra: [`lib/providerErrors.js`](../lib/providerErrors.js).
> Origem: incidente de saldo esgotado (#353) e a varredura que ele motivou (#355 → #358, #359).

A OpenAI falha de vez em quando — saldo que acaba no meio de uma janela de
entrevistas, chave revogada, erro de servidor. O que importa aqui não é a falha:
é **quem paga por ela**. Duas coisas davam errado, e são independentes.

## 1. O aluno levava a culpa (#358)

O padrão se repetia em vários pontos: o provedor recusa a chamada e o sistema
responde com uma mensagem que aponta para o aluno.

- A falha de STT virava *"não consegui entender o áudio, tente gravar de novo"* —
  para **qualquer** causa, inclusive falta de saldo. O aluno regravava, falhava
  igual, e concluía que o problema era o microfone dele.
- A falha do orquestrador virava `ask_repeat`. Como `ask_repeat` **não marca**
  `answered_at`, ele não conta para o teto de turnos: com uma falha persistente,
  a entrevista virava um "pode repetir?" sem fim, porque o cap nunca chegava.
- A preparação da entrevista simplificada guardava `err.message` cru — que o
  `/live/prep-status` entregava direto à tela.

**A regra agora:** toda mensagem que chega ao aluno passa por
`mensagemParaOAluno(err)`. Ela separa duas classes, porque as saídas são
opostas:

| Classe | O que o aluno faz |
|---|---|
| **é o seu equipamento** | regravar/tentar de novo resolve |
| **é do nosso lado** | tentar de novo **não** resolve — avise o professor |

`err.message` é texto de log. Na tela do aluno ele não orienta ninguém e ainda
costuma ser lido como defeito do arquivo ou do equipamento dele.

O teto `MAX_ORCHESTRATOR_FAILS` (3 falhas **consecutivas**, zeradas a cada
sucesso) fecha o laço infinito: passou disso, a sessão sai com recado honesto em
vez de fingir mais um turno.

## 2. O resultado parecia válido e não era (#359)

Mais perigoso, e por um motivo específico: **uma prova que não abre, o aluno
reclama; uma prova avaliada sem as respostas dele passa por legítima e vira
nota.** Ninguém reporta o que parece ter funcionado.

- `input_audio_transcription.failed` não era tratado. O slot reservado ficava
  vazio e era filtrado no fechamento — a resposta sumia sem rastro e a prova era
  avaliada **como se o aluno não tivesse respondido**.
- O erro do Realtime só era fatal **antes** da confirmação da sessão (#351).
  Saldo que acabava no meio voltava a ser "log e segue": a conexão ficava viva e
  muda, o keep-alive segurando, e o aluno falava para o nada.
- Transcrição que falhava ao persistir não impedia marcar a sessão como
  concluída — depois a avaliação rodava sobre nada.
- A retranscrição de auditoria **omitia** as respostas que falharam, e o prompt
  manda o avaliador confiar nela como fonte de maior fidelidade.
- Falha ao listar os áudios virava lista vazia, indistinguível de modo texto.

**O princípio:** avaliação sem insumo completo não produz resultado em silêncio.
Onde o insumo falhou, isso chega ao professor **antes** da nota.

Na prática:

- Transcrição que falha vira **marca legível** no lugar da resposta
  (`FALA_NAO_TRANSCRITA`), e o contador vai aos sinais de voz
  (`transcription_failures`). Ausência de texto ≠ ausência de resposta.
- Erro fatal do provedor com a sessão em andamento **encerra** com
  `reason: "provider_error"`, e a tela do aluno diz que foi falha nossa — não o
  manda "procurar uma rede mais estável", que é o mesmo erro do item 1.
- Sem transcrição persistida, **não** há conclusão: a submissão fica pendente, o
  aluno não perde a tentativa e o professor vê que algo ficou por resolver.
- O bloco de auditoria **anuncia as próprias lacunas** no prompt, para o
  avaliador não ler ausência como silêncio do aluno.
- Insumo que falhou ao carregar sai como `notReady` — o lote marca "pulada" com
  motivo, em vez de entregar resultado pior sem avisar.

### O que é fatal e o que é ruído

`erroFatalDoProvedor()` existe porque o relay recebe muitos `error` inofensivos
(item inexistente ao cancelar, buffer curto, resposta já cancelada). Derrubar
uma arguição por causa deles seria pior que o defeito original. Fatal é o que
não se recupera continuando: perder autorização, saldo ou o modelo.

## Ao mexer aqui

Antes de escrever uma mensagem de erro que o aluno vai ler, pergunte: **existe
algo que ele possa fazer?** Se não existe, a mensagem precisa dizer isso e
apontar o professor. Sugerir uma ação inútil ("tente de novo", "recarregue")
não é neutro: consome o tempo dele no meio de uma avaliação e o convence de que
a culpa é dele.

Testes: [`tests/falhas-de-provedor.test.mjs`](../tests/falhas-de-provedor.test.mjs).

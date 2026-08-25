# 0023 — Sound check em escada: vermelho bloqueia o início, com três saídas

> **Estado:** Aceita
> **Data:** 2026-08-24

## Contexto

A calibração de fala (leitura de frase, migration 040) sempre foi **não
bloqueante** — e os dados do incidente de 18/08 mostraram que ela é
estruturalmente cega aos modos de falha dominantes: dos 5 reprovados que
seguiram, 3 tiveram o desastre previsto; a Rebeca **passou** com WER 0,2 e teve
100% de alucinação por **eco** (a voz do examinador voltando pelo microfone —
que nenhuma leitura de frase jamais verá); o George passou "limpo" na 2ª
tentativa depois de uma 1ª com WER 0,765 e degradou no meio da prova.

Bloquear com a calibração antiga teria ~40% de bloqueio injusto. A condição
para poder bloquear era **medir os modos de falha reais** primeiro.

## Decisão

1. **Duas sondas novas** (issue #288), além da leitura:
   - **Teste de eco**: o servidor toca uma frase com palavras-marcador
     distintivas na voz do examinador; o aluno fica em silêncio; o STT do que o
     microfone captou acusa vazamento (≥2 marcadores). É **medição direta** do
     modo de falha da Rebeca — e usa o mesmo caminho de áudio da sessão
     (inclusive o cancelamento de eco do navegador), então mede o que a prova
     de fato terá.
   - **Detecção de HFP** (fone Bluetooth em modo chamada): rótulo do
     dispositivo + penhasco espectral acima de ~7 kHz, no navegador.
     **Sempre aviso acionável, nunca bloqueio** — é heurística.
2. **Escada** (`lib/soundCheck.js#ladderState`, fonte única):
   - **VERDE** segue; **AMARELO** segue com aviso persistente (leitura
     reprovada não-dura, uma reprovação dura, um eco, HFP, ou instabilidade
     tipo George — o **pior** resultado fica registrado, não só o último);
   - **VERMELHO** = **dois sinais duros** (duas leituras com WER ≥ 0,6, ou eco
     confirmado em dois testes) — o aluno **não inicia sozinho**.
3. **Vermelho nunca é beco** — três saídas, nesta ordem: checklist de correção
   de custo zero (fone com fio à frente) + re-teste (os sinais duros contam
   sobre as **últimas 2 medições** de cada sonda — ambiente corrigido limpa o
   vermelho); reagendamento **sem penalidade**; liberação pelo professor
   (`waive-soundcheck`, permanente por submissão — molde do waive-video).
   O professor vê os vermelhos na lista **antes do dia da prova**.
4. O gate fica na **interface** (no clique do Continuar, via setupGate —
   mesmo desenho do gate de fones/#255). Trabalho sem frase de calibração
   continua sem sound check (fail-open, como sempre).

## Consequências

- É a primeira etapa de setup que **bloqueia por qualidade de captação** —
  vizinha das ADRs 0005 (vídeo bloqueante) e 0020 (queda pausa na primeira):
  falhar em aberto custava a avaliação do aluno.
- Limiares iniciais (WER duro 0,6; 2 marcadores; penhasco espectral) são de
  bom senso, concentrados em `lib/soundCheck.js` — a telemetria acumulada
  (`oral_calibration_json` guarda cada medição) permite calibrá-los.
- Vale para os fluxos de VOZ (prova oral e entrevista realtime). A entrevista
  por mensagem mantém a calibração antiga (o monitor #287 é a defesa dela);
  estender a escada para lá é decisão futura.

## Adendo (mesmo dia, antes de qualquer deploy)

O teste é **obrigatório**: o Continuar bloqueia enquanto a leitura não estiver
resolvida (aprovada ou tentativas esgotadas) E o eco não tiver rodado ao menos
uma vez (`soundCheckPending`). Sem isso, o aluno com eco driblaria o gate
simplesmente não testando — a escada só protege quem mede. Erro de
infraestrutura (STT/TTS fora do ar) faz **fail-open**: o gate é contra pular o
teste, não contra o azar; e a liberação do professor também destrava.

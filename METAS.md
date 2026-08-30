# METAS do ORATIA

Base normativa do produto: é contra isto, junto com os princípios e o roadmap
da skill `oratia-improve`, que o `oratia-revisor` julga se uma entrega serve ao
que se pretende — e não apenas se está tecnicamente correta.

**Meta não é frente de roadmap.** A frente diz *o que construir*; a meta diz
*para que* e *como se sabe que deu certo*. Uma entrega pode cumprir a frente
perfeitamente e não mover meta alguma — e é justamente isso que a revisão deve
ser capaz de apontar.

## Como o revisor usa este arquivo

Os graus e o que reprova estão no `PRIMER.md`, que é a fonte — este arquivo não
cria critério próprio. O que ele determina é **o que conta como meta**:

- **Meta declarada** (seção abaixo) é critério, e entra na classificação do
  primer como "meta declarada".
- **Meta marcada `POR DECLARAR` não é critério.** O revisor **não reprova** por
  ela.
- **Meta nenhuma cobre o caso?** Julgue pelos princípios inegociáveis, pelas
  ADRs e pelo objetivo declarado da própria entrega. Não invente meta para
  reprovar.

Este arquivo é **do usuário**. Um agente propõe redação e traz evidência; quem
declara, altera ou remove meta é o usuário.

---

## Metas declaradas

> Nenhuma ainda. Enquanto esta seção estiver vazia, o revisor julga pelos
> princípios inegociáveis, pelas ADRs do tronco e pelo objetivo declarado da
> entrega — que é o comportamento correto, não uma lacuna a contornar.

<!--
Modelo para cada meta. Copie o bloco e preencha.

### M-01 — <nome curto>

- **Objetivo**: o que se quer alcançar, em uma frase.
- **Por quê**: que problema real isso resolve, para quem.
- **Como se mede**: sinal observável que distingue alcançado de não alcançado.
  Sem isto a meta não é critério, é intenção.
- **Frentes relacionadas**: números do roadmap em `oratia-improve`.
- **Estado**: ativa | alcançada | suspensa
-->

## Candidatas — POR DECLARAR

Levantadas de fatos verificados no repositório, **não confirmadas como metas**.
Não são critério de revisão enquanto não forem promovidas acima.

| # | Candidata | De onde veio | Falta |
|---|---|---|---|
| C-01 | Suportar mais de um idioma, com idioma por trabalho | issues abertas no tronco sobre acoplamento ao português na lógica, não só nas telas | confirmar se é meta ou só demanda técnica; definir a medida |
| C-02 | Ter suíte de regressão e CI | frente 10 do roadmap; hoje não existe CI em nenhuma branch (verificado) | definir cobertura mínima que conta como alcançada |
| C-03 | Reduzir a assimetria de proteção entre as áreas do professor e do administrador | débito conhecido em `oratia-improve`: cockpit do professor protegido só por capability URL | confirmar prioridade; definir alvo |

Promover uma candidata a meta é decisão do usuário: mova para *Metas
declaradas*, preencha `Como se mede` e remova a linha daqui.

## Registro de mudanças

Meta declarada, alterada ou removida deixa registro — o revisor precisa saber
contra qual versão julgou.

| Data | O quê | Por quê |
|---|---|---|
| 2026-08-30 | Arquivo criado, sem metas declaradas | O portão de revisão passou a exigir base normativa explícita; as metas não estavam registradas em lugar nenhum |

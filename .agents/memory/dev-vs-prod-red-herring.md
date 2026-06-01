---
name: "Dev funciona / prod não" pode ser data-dependent, não infra
description: Como diagnosticar relatos de "funciona no dev mas não em produção" neste app antes de culpar cache/deploy/migrations.
---

# "Funciona no dev, não em produção" raramente é infra aqui

Quando o usuário relatar um comportamento que só falha em produção, NÃO presuma
de cara cache de navegador, CDN, deploy velho ou migrations. Já houve um caso em
que a real diferença era **os dados**: o bug só disparava em registros `works`
SEM identidade de entrevistador salva (`interviewer_name`/`interviewer_gender`
nulos), levando o frontend a um ramo de código frágil. O usuário "via funcionar"
em dev só porque testava outro trabalho, que tinha identidade salva.

**Como aplicar (ordem de verificação antes de teorizar):**
1. Banco de prod (read-only): a escrita realmente aconteceu? (provou que sim)
2. `curl` ao endpoint em prod: a API devolve o dado certo? cabeçalhos (cache)?
3. Comparar `md5` do HTML/JS servido em prod vs repositório: frontend é o atual?
4. Checar Service Worker / cache de origem.
5. Só então pedir evidência do **console do navegador** (F12) do usuário — foi o
   console que entregou o `TypeError` exato e fechou o diagnóstico em 1 passo.

**Why:** muito tempo foi gasto perseguindo cache/Service Worker/deploy quando a
causa era um throw de runtime data-dependent que o servidor jamais revelaria.

**Armadilha de design correlata:** renderização de lista crítica não pode ficar
atrás de `await` de chamada cosmética (ex.: sugestão de nome). Um `load()`
chamado fire-and-forget (sem try/catch) transforma qualquer throw nele em falha
silenciosa — a lista simplesmente não atualiza, sem erro visível.

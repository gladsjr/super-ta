---
name: Preços de deploy — fonte da verdade
description: searchReplitDocs devolve preços de deployment errados/desatualizados; use a tela de Publicação ou a página de preços.
---

# Preços de deployment: confie na UI, não no searchReplitDocs

`searchReplitDocs` devolveu **US$ 500/mês** para o tier Reserved VM **2 vCPU / 8 GB**. O preço real (visto na tela de Publicação do usuário) é **US$ 80/mês**. Tabela real de Reserved VM:

- Shared 0,5 vCPU / 2 GB — US$ 20/mês
- 1 vCPU / 4 GB — US$ 40/mês
- 2 vCPU / 8 GB — US$ 80/mês
- 4 vCPU / 16 GB — US$ 160/mês
- (não existe 4 vCPU / 8 GB; 4 vCPU vem com 16 GB)

**Why:** Eu afirmei ~US$ 500 com base no docs e o usuário rebateu com o print correto. Quotar preço errado quebra confiança e assusta um usuário sensível a custo.

**How to apply:** Nunca crave preço de deployment a partir do `searchReplitDocs`. Para valores, aponte para a **tela de Publicação** (mostra o valor exato do tier selecionado) ou `replit.com/pricing`. Os números acima são válidos em ~jun/2026; preços mudam — sempre reconfirme na UI.

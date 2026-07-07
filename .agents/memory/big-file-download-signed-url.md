---
name: Entregar arquivos grandes ao usuário (download no navegador)
description: present_asset "Open" trava com binários grandes; use Object Storage + signed URL via sidecar para dar link de download temporário.
---

**Regra:** para entregar arquivos grandes (>~50MB, ex. ZIP de áudios) ao usuário para download no navegador, não confie no cartão do present_asset — o botão "Open" tenta abrir o binário no editor e trava, sem opção de download utilizável.

**Why:** aconteceu com um ZIP de 165MB de áudios; o usuário não conseguiu baixar pelo cartão nem quis mudanças no código do app para servir o arquivo.

**How to apply:**
1. Subir o arquivo ao bucket com chave aleatória privada: `new Client({ bucketId: process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID }).uploadFromFilename(key, path)`.
2. Assinar URL GET temporária via sidecar local: `POST http://127.0.0.1:1106/object-storage/signed-object-url` com JSON `{bucket_name, object_name, method:"GET", expires_at:ISO}` → `signed_url` (padrão do blueprint javascript_object_storage).
3. Não colar a URL no chat (contém o bucket id, que é secret): gravar num .txt pequeno e apresentar via present_asset (txt abre bem no editor; usuário copia o link).
4. Verificar com `curl -I` sem imprimir a URL; apagar o objeto do bucket após o download confirmado (a URL expira sozinha de qualquer forma).
5. Montar tudo em `tmp/` (gitignored) para nada ir ao Git/GitHub.

**Nota sandbox:** o notebook code_execution NÃO tem `process` global nem env vars do projeto — downloads/uploads com env devem rodar como script Node via bash.

---
name: Object Storage bucket binding (@replit/object-storage)
description: Por que o arquivamento de áudio era no-op silencioso e como vincular o bucket à SDK.
---

# Vincular bucket ao `@replit/object-storage`

A SDK `@replit/object-storage` (v1.x) **não** lê o bucket da env
`DEFAULT_OBJECT_STORAGE_BUCKET_ID` sozinha. `new Client()` sem args espera a
seção `[objectStorage] defaultBucketID` no `.replit` — que o tool
`setup_object_storage` **não** escreve (ele só adiciona env vars). Resultado:
`new Client()` constrói ok, mas o primeiro `uploadFromBytes` falha com
`"A bucket name is needed to use Cloud Storage."`.

**Regra:** passar o id explicitamente — `new Client({ bucketId: process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID })`.

**Why:** o adapter de áudio (backend `replit`) degrada best-effort (put vira
no-op, nunca lança), então a ausência do bucket ficou mascarada — entrevistas
seguiam funcionando e nada era arquivado. Em prod aparecia só como
`AUDIO_STORE put no-op ... reason=...fetch failed`.

**How to apply:** ao usar Object Storage neste app (plain JS, não o blueprint
TS/React/Uppy), confie no env var + bucketId explícito. Não editar `.replit`
direto (guard bloqueia). O blueprint `javascript_object_storage` despeja
arquivos TS/React/Uppy e deps (@google-cloud/storage, @uppy/*) que são
irrelevantes aqui — remover. Prod precisa de **republish** para herdar a env
var do bucket e o código novo.

**Cuidado residual:** `available=true` no boot só significa "Client construído",
não I/O validado. Falha de bucket/propagação só aparece no primeiro `put`.

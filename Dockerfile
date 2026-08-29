# Imagem de desenvolvimento do ORATIA.
#
# Existe nesta branch (`oratia-sdlc`), não no tronco: é ferramental de SDLC, e o
# repositório de código permanece intocado. O serviço `db` NÃO é definido aqui —
# vem do `docker-compose.yml` do tronco via `include`, que é a fonte única da
# definição do banco.
#
# Dois alvos, conforme o modo de trabalho:
#   dev  — código chega por bind mount; `node_modules` vive em volume nomeado.
#   pack — código copiado para dentro da imagem; valida que o empacotamento
#          funciona a partir do zero, sem depender do host.

# ---------------------------------------------------------------------------
# base — sistema operacional e binários de runtime, comuns aos dois alvos.
# ---------------------------------------------------------------------------
# Node 20: versão que o projeto declara em `.replit` (modules = nodejs-20). O
# host do colaborador pode ter qualquer versão — dentro do container é sempre
# esta, que é o ponto de fixar a imagem.
FROM node:20-bookworm-slim AS base

# ffmpeg: exigido pela extração de quadros do proctoring de vídeo e pelo
# processamento de áudio. É a dependência de sistema que mais falta no host
# (não vem em Windows nem em macOS por padrão).
#
# ca-certificates: chamadas HTTPS à API da OpenAI.
#
# tini: PID 1 que encaminha sinais e recolhe processos zumbis. Sem ele o
# `node` roda como PID 1, ignora SIGTERM e todo `docker compose down` espera
# o timeout de 10s antes de matar à força.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        ffmpeg \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENTRYPOINT ["/usr/bin/tini", "--"]

# ---------------------------------------------------------------------------
# dev — alvo padrão. Não copia código: ele chega por bind mount do compose.
# ---------------------------------------------------------------------------
# A imagem fica deliberadamente vazia de aplicação. Quem popula `/app` é o bind
# mount de `./super-ta`, e quem popula `/app/node_modules` é o serviço `deps`,
# que escreve no volume nomeado. Esse volume PRECISA existir sobreposto ao bind
# mount: os binários nativos (`bcrypt`, `onnxruntime-node`) que o host compila
# são de outra plataforma e não carregam aqui dentro.
FROM base AS dev
CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
# pack — imagem fechada, para verificar o empacotamento sem o host.
# ---------------------------------------------------------------------------
FROM base AS pack

# Manifestos primeiro, numa camada só: enquanto as dependências não mudarem, o
# `npm ci` é reaproveitado do cache mesmo que o código mude.
COPY super-ta/package.json super-ta/package-lock.json ./

# `npm ci` (não `install`): instala exatamente o que o lockfile fixa e falha se
# os dois divergirem — que é o comportamento desejado ao validar empacotamento.
#
# `--foreground-scripts`: os scripts de instalação de `bcrypt` e
# `onnxruntime-node` buscam os binários pré-compilados da plataforma. Sem o
# flag a saída deles é engolida, e uma falha aparece só muito depois, como um
# módulo que não carrega.
RUN npm ci --foreground-scripts --no-audit --no-fund

COPY super-ta/ ./

CMD ["node", "server.js"]

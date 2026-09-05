// Entrega de vídeo com HTTP Range de verdade (#349).
//
// O que existia antes: `readAllBytes(key)` + fatiamento do Buffer. Em produção
// (Object Storage) isso carrega o arquivo INTEIRO na memória a cada requisição —
// e como o player usa preload="metadata", só abrir a tela já dispara. Uma
// arguição de 60 min tem ~190 MB, com pico do dobro no Buffer.concat, numa VM de
// 8 GB que também hospeda o relay de voz. Um vídeo de ~40 min já derrubou a
// máquina em 16/08/2026 (pelo lado da análise, corrigido à parte).
//
// Aqui só passa a faixa pedida, byte a byte, nos dois backends.
//
// Sem o tamanho total não dá para montar Content-Range — e isso NÃO é só perder
// o seek (#376). O WebM do MediaRecorder não traz duração no cabeçalho, então o
// navegador precisa ler o FIM do arquivo para descobri-la; sem Range ele não
// chega lá e o player nunca inicializa: fica em HAVE_NOTHING, tela preta, sem
// erro. Ou seja, servir 200 sem tamanho é o mesmo que não servir.
//
// Por isso o tamanho é perseguido em três degraus: object_sizes (gravado no
// upload desde a migration 080) → medição sob demanda, gravada para as próximas
// (conserta o legado) → contagem dos bytes ao servir, que cura na requisição
// seguinte. O 200 sem tamanho continua existindo, mas agora é o último recurso e
// se anuncia no log.
import { streamRange, objectSize } from "./audioStore.js";
import { getObjectSize, setObjectSize } from "./db.js";
import log from "./logger.js";

export function videoMimeFromKey(key) {
    const ext = String(key || "").split(".").pop().toLowerCase();
    if (ext === "mp4" || ext === "m4a") return "video/mp4";
    if (ext === "ogg" || ext === "ogv") return "video/ogg";
    return "video/webm";
}

// Interpreta um cabeçalho Range de uma faixa só. Devolve null quando ausente ou
// ilegível (o caller serve inteiro) e {erro:true} quando é sintaticamente válido
// mas impossível de satisfazer (→ 416).
export function parseRange(header, total) {
    if (!header || !Number.isFinite(total) || total <= 0) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!m) return null;
    const temInicio = m[1] !== "", temFim = m[2] !== "";
    if (!temInicio && !temFim) return null;
    let start, end;
    if (temInicio) {
        start = parseInt(m[1], 10);
        end = temFim ? parseInt(m[2], 10) : total - 1;
    } else {
        // sufixo: "bytes=-500" = os últimos 500 bytes
        const n = parseInt(m[2], 10);
        if (n <= 0) return { erro: true };
        start = Math.max(0, total - n);
        end = total - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end >= total) end = total - 1;
    if (start > end || start >= total) return { erro: true };
    return { start, end };
}

// Serve `key` respeitando Range. O tamanho vem do banco (object_sizes, gravado
// no upload); no backend local o filesystem responde direto.
export async function serveVideo(req, res, key, contexto = "") {
    const type = videoMimeFromKey(key);
    let tamanho = await getObjectSize(key);
    // Sem registro no banco (objeto anterior à migration 080): MEDE agora e
    // guarda, para esta e as próximas requisições (#376). Antes isto só
    // funcionava no backend local, então em produção caía direto no 200 cru.
    if (!Number.isFinite(tamanho) || tamanho <= 0) {
        tamanho = await objectSize(key);
        if (Number.isFinite(tamanho) && tamanho > 0) {
            setObjectSize(key, tamanho).catch(e => log.warn("VIDEO", `não gravou o tamanho medido key=${key}: ${e.message}`));
            log.info("VIDEO", `tamanho medido sob demanda key=${key} bytes=${tamanho}`);
        }
    }

    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "private, max-age=3600");

    // Não deu para medir: serve inteiro em stream, como antes — mas CONTANDO os
    // bytes e gravando o total no fim (#376). A requisição corrente ainda sai
    // sem Range (o navegador pode não conseguir tocar), porém a próxima já
    // encontra o tamanho no banco e recebe 206. É a rede de segurança para o
    // caso de a sonda da SDK deixar de funcionar: degrada uma vez, e se cura.
    if (!Number.isFinite(tamanho) || tamanho <= 0) {
        log.warn("VIDEO", `tamanho desconhecido key=${key} — servindo sem Range; o player pode não inicializar (#376)`);
        const s = await streamRange(key);
        if (!s) return res.status(404).json({ error: "vídeo indisponível no armazenamento" });
        return canalizar(s, res, key, contexto, { medirEGravar: true });
    }

    res.setHeader("Accept-Ranges", "bytes");
    const faixa = parseRange(req.headers.range, tamanho);

    if (faixa && faixa.erro) {
        res.status(416).setHeader("Content-Range", `bytes */${tamanho}`);
        return res.end();
    }

    if (!faixa) {
        res.setHeader("Content-Length", tamanho);
        const s = await streamRange(key);
        if (!s) return res.status(404).json({ error: "vídeo indisponível no armazenamento" });
        return canalizar(s, res, key, contexto);
    }

    const { start, end } = faixa;
    const s = await streamRange(key, { start, end });
    if (!s) return res.status(404).json({ error: "vídeo indisponível no armazenamento" });
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${tamanho}`);
    res.setHeader("Content-Length", end - start + 1);
    return canalizar(s, res, key, contexto);
}

function canalizar(stream, res, key, contexto, { medirEGravar = false } = {}) {
    let bytes = 0;
    if (medirEGravar) {
        stream.on("data", (chunk) => { bytes += chunk.length; });
        // Só grava se a resposta chegou INTEIRA ao fim. Uma conexão abortada no
        // meio daria um total menor que o arquivo — e um tamanho errado em
        // object_sizes é pior que nenhum: o Content-Range passaria a mentir.
        stream.on("end", () => {
            if (bytes <= 0) return;
            setObjectSize(key, bytes)
                .then(() => log.info("VIDEO", `tamanho aprendido ao servir key=${key} bytes=${bytes} (#376)`))
                .catch(e => log.warn("VIDEO", `não gravou o tamanho contado key=${key}: ${e.message}`));
        });
    }
    stream.on("error", (err) => {
        log.error("VIDEO", `stream falhou${contexto ? ` ${contexto}` : ""} key=${key}: ${err.message}`);
        if (!res.headersSent) res.status(502).json({ error: "falha ao ler o vídeo" });
        else res.destroy();
    });
    // Abortar a resposta (o professor fechou a aba, ou o player pulou de trecho)
    // precisa fechar o stream de origem — senão a conexão com o storage fica de pé.
    res.on("close", () => { if (!stream.destroyed) stream.destroy(); });
    stream.pipe(res);
}

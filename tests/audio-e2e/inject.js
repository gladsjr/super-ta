// Injetado via page.addInitScript ANTES de qualquer script da página.
//
// Substitui o microfone real por um MediaStream que NÓS alimentamos. Assim a
// student.html grava (via MediaRecorder) exatamente o áudio que o simulador de
// aluno produz a cada turno — sem microfone físico e sem relançar o Chrome.
//
// IMPORTANTE: cada chamada de getUserMedia devolve um stream NOVO. O frontend
// encerra as tracks (teardown) ao fim de cada turno; se reusássemos o mesmo
// stream, a track estaria morta no turno seguinte e a gravação nao iniciaria.
//
// Mecânica:
//   - Um AudioContext. A cada getUserMedia criamos um novo
//     MediaStreamAudioDestinationNode (currentDest) e devolvemos o `.stream`
//     dele. Um ganho mudo fica conectado pra manter a track "viva" (silencio).
//   - window.__superTASpeak(base64Mp3) decodifica o mp3 da fala do aluno e o
//     toca no currentDest (o ultimo entregue por getUserMedia, ou seja, o que o
//     MediaRecorder atual esta gravando). Resolve quando a fala termina (+ um
//     respiro de silencio pra nao cortar o fim no encerramento do recorder).
(() => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();

    // Fonte de silencio sempre ligada: conectada a cada novo destino, mantem a
    // faixa de audio continua mesmo quando nada esta sendo falado.
    const silent = ctx.createConstantSource();
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    silent.connect(silentGain);
    try { silent.start(); } catch (e) {}

    let currentDest = null;

    function b64ToArrayBuffer(b64) {
        const bin = atob(b64);
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    // Fala uma resposta do aluno (mp3 em base64) no microfone falso atual.
    window.__superTASpeak = async (b64Mp3) => {
        if (ctx.state === "suspended") { try { await ctx.resume(); } catch (e) {} }
        if (!currentDest) {
            currentDest = ctx.createMediaStreamDestination();
            silentGain.connect(currentDest);
        }
        const buf = await ctx.decodeAudioData(b64ToArrayBuffer(b64Mp3));
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(currentDest);
        await new Promise((resolve) => {
            src.onended = resolve;
            src.start();
        });
        // Respiro de ~250ms pra garantir que o ultimo chunk do MediaRecorder
        // contenha o fim da fala antes do stop().
        await new Promise((r) => setTimeout(r, 250));
    };

    window.__superTAReady = true;

    // getUserMedia falso: stream NOVO a cada chamada (track sempre viva).
    const fakeGUM = async (constraints) => {
        if (constraints && constraints.video) {
            throw new DOMException("video not supported in fake device", "NotFoundError");
        }
        currentDest = ctx.createMediaStreamDestination();
        silentGain.connect(currentDest);
        return currentDest.stream;
    };

    if (!navigator.mediaDevices) {
        Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
    }
    navigator.mediaDevices.getUserMedia = fakeGUM;
    navigator.getUserMedia = (c, ok, err) => fakeGUM(c).then(ok, err);
})();

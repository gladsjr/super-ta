// Proctoring local da prova oral (pós-prova, em lote). Amostra frames do vídeo
// gravado e roda dois modelos YOLOv8n (ONNX, via onnxruntime-node, CPU):
//  - detect (COCO): conta pessoas (0 = ausente, ≥2 = mais de uma) e celular.
//  - pose: keypoints dos punhos da pessoa principal → "ambas as mãos visíveis".
// Tudo LOCAL — o vídeo nunca sai da infra. Gera flags para REVISÃO HUMANA,
// nunca acusação automática. Sem Python no runtime.

import { spawn } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { PROJECT_ROOT } from "./config.js";
import { streamAudio } from "./audioStore.js";
import log from "./logger.js";

// Política ÚNICA de "vídeo obrigatório": true quando a arguição exige proctoring
// de vídeo. Vale para a entrevista por mensagem com proctoring ligado E para os
// dois fluxos por voz (prova oral e entrevista simplificada), que são câmera-on
// por natureza. Aceita tanto o objeto `work` do middleware (kind/interview_variant)
// quanto o `found` do relay realtime (work_kind/work_interview_variant).
export function videoMandatory(work) {
    if (!work) return false;
    const kind = work.kind ?? work.work_kind;
    const variant = work.interview_variant ?? work.work_interview_variant;
    return work.proctoring_enabled === true || kind === "oral_realtime" || variant === "realtime";
}

const IMGSZ = 640;
const DET_CONF = 0.40;   // confiança mínima (pessoa)
const IOU = 0.45;
const POSE_PCONF = 0.50; // confiança mínima da pessoa (pose)
const KP_CONF = 0.30;    // confiança do punho p/ "visível" — baixo de propósito:
                         // mãos cruzadas/parciais/perto da borda dão conf baixa mas
                         // ESTÃO visíveis. Só mão fora do quadro cai perto de 0.
const FRAME_SEC = 1;     // 1 frame a cada N segundos. Denso DE PROPÓSITO: o
                         // proctoring é pós-prova (batch), então amostrar a cada
                         // 1s custa só tempo de CPU (não afeta a prova ao vivo) e
                         // melhora o recall de eventos breves (ex.: relance de
                         // celular <3s que caía entre frames a 3s).
// ORÇAMENTO de quadros por vídeo (não é mais um corte cego no minuto 20).
// A trava existe para proteger a CPU da VM: ~0,6 s de inferência por quadro, então
// 1200 quadros ≈ 12 min de CPU por vídeo. Antes isso era um teto que TRUNCAVA em
// silêncio — prova de 44 min era analisada só até o minuto 20 e o relatório não
// registrava nada (issue #249). Agora o orçamento é gasto ao longo do vídeo
// INTEIRO: o intervalo de amostragem estica quando a prova é longa.
const FRAME_BUDGET = 1200;
// ATENÇÃO ao esticar: com intervalo > 1 s, `count` deixa de equivaler a segundos.
// Por isso cada flag passa a trazer `count_sec` (count × intervalo). Vídeos até o
// orçamento continuam a 1 s/quadro — nada muda no caso comum.
// Celular: exige área mínima do bounding box (relógio/smartwatch é pequeno) para
// não confundir com o telefone. Confiança relativamente baixa DE PROPÓSITO: numa
// webcam, um celular tirado do bolso e olhado de relance aparece pequeno e em
// ângulo — o yolov8n dá confiança ~0.30-0.35 (medido num caso real: celular em
// 1:18 saiu com conf 0.34 e área ~1%, e era rejeitado por 0.45/1,5%). Para o
// FALSO-POSITIVO, a defesa é a ÁREA (relógio ~<0.5%) + exigir ≥2 frames para o
// alerta (proctorAlerts), não a confiança alta. Proctoring é revisão humana.
const PHONE_CONF = 0.30;
const PHONE_MIN_AREA = 0.007; // 0,7% da área do frame (exclui relógio; inclui celular a ~distância)
// Re-verificação com ZOOM (2ª passada): mão/antebraço em movimento perto do rosto
// vira "cell phone" conf 0.27-0.51 no yolov8n (medido num caso real: aluno
// gesticulando disparou 46 frames de celular, 0 celulares). A defesa: recortar a
// região do box com margem, ampliar para 640 e re-inferir — no zoom a mão vira
// "person" e o celular some (5/5 FPs eliminados no caso medido); um celular real
// ampliado só fica MAIS confiante. Só confirma flags, nunca cria: FP estritamente
// não-crescente. O relatório guarda raw_count para auditoria.
const PHONE_ZOOM = 2.5;      // margem do recorte (× o maior lado do box)
const PHONE_ZOOM_MIN = 160;  // lado mínimo do recorte (px do frame letterboxed)

const MODELS = {
    detect: path.join(PROJECT_ROOT, "models", "yolov8n.onnx"),
    pose: path.join(PROJECT_ROOT, "models", "yolov8n-pose.onnx"),
};
// onnxruntime-node é módulo NATIVO e só serve à análise de vídeo PÓS-prova.
// Carregamento PREGUIÇOSO + guardado: se o binário nativo não existir/instalar no
// ambiente (ex.: deploy numa VM sem suporte), o servidor BOOTA normalmente — a
// entrevista e a prova oral AO VIVO seguem funcionando; só o proctoring de vídeo
// fica indisponível (lança erro claro, que as rotas já tratam por item).
let ort = null, ortTried = false;
async function loadOrt() {
    if (ort || ortTried) return ort;
    ortTried = true;
    try { ort = (await import("onnxruntime-node")).default; }
    catch (e) { log.warn("PROCTOR", `onnxruntime-node indisponível — proctoring de vídeo desligado: ${e.message}`); ort = null; }
    return ort;
}

let _sessions = null;
async function sessions() {
    if (_sessions) return _sessions;
    const o = await loadOrt();
    if (!o) return null; // sem onnx → caller degrada (não há proctoring)
    const opt = { executionProviders: ["cpu"], graphOptimizationLevel: "all" };
    // "mãos visíveis" via keypoints de punho (YOLOv8-pose) foi DESLIGADO: numa
    // webcam de rosto com mãos juntas/perto do queixo, o modelo dá confiança de
    // punho ~0.05-0.3 mesmo com as mãos claramente à mostra → falso positivo
    // crônico. Precisa de um detector de MÃO dedicado (MediaPipe/YOLO-hand) para
    // voltar com confiança. Por ora só carregamos o detector de objetos/pessoa.
    _sessions = { detect: await ort.InferenceSession.create(MODELS.detect, opt) };
    return _sessions;
}

// rgb24 HWC (Buffer 640*640*3) → Float32 CHW normalizado [1,3,640,640]
function frameToTensor(buf) {
    const HW = IMGSZ * IMGSZ;
    const f = new Float32Array(3 * HW);
    for (let i = 0; i < HW; i++) {
        f[i] = buf[i * 3] / 255;
        f[HW + i] = buf[i * 3 + 1] / 255;
        f[2 * HW + i] = buf[i * 3 + 2] / 255;
    }
    return new ort.Tensor("float32", f, [1, 3, IMGSZ, IMGSZ]);
}
async function infer(session, tensor) {
    const feeds = {}; feeds[session.inputNames[0]] = tensor;
    const out = await session.run(feeds);
    return out[session.outputNames[0]];
}
function iou(a, b) {
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
    const w = Math.max(0, x2 - x1), h = Math.max(0, y2 - y1), inter = w * h;
    const aa = (a[2] - a[0]) * (a[3] - a[1]), ab = (b[2] - b[0]) * (b[3] - b[1]);
    return inter / (aa + ab - inter + 1e-9);
}
function nms(dets, thr) {
    dets.sort((p, q) => q.score - p.score);
    const keep = [], removed = new Array(dets.length).fill(false);
    for (let i = 0; i < dets.length; i++) {
        if (removed[i]) continue;
        keep.push(dets[i]);
        for (let j = i + 1; j < dets.length; j++)
            if (!removed[j] && iou(dets[i].box, dets[j].box) > thr) removed[j] = true;
    }
    return keep;
}
// detect: (1,84,8400) → contagem de pessoas (classe 0) + celular (classe 67)
function parseDetect(out) {
    const d = out.data, A = out.dims[2], NC = out.dims[1] - 4;
    const persons = [], phones = [];
    const FRAME_AREA = IMGSZ * IMGSZ;
    for (let a = 0; a < A; a++) {
        let best = -1, bc = 0;
        for (let k = 0; k < NC; k++) { const s = d[(4 + k) * A + a]; if (s > bc) { bc = s; best = k; } }
        if (best !== 0 && best !== 67) continue;
        const cx = d[a], cy = d[A + a], w = d[2 * A + a], h = d[3 * A + a];
        const box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
        if (best === 0) {
            if (bc < DET_CONF) continue;
            persons.push({ box, score: bc });
        } else { // celular (classe 67): conf alta + área mínima (exclui relógio)
            if (bc < PHONE_CONF) continue;
            if ((w * h) / FRAME_AREA < PHONE_MIN_AREA) continue;
            phones.push({ box, score: bc });
        }
    }
    return { persons: nms(persons, IOU).length, phoneBoxes: nms(phones, IOU) };
}
// pose: (1,56,8400) → punhos da pessoa de maior confiança
function parsePose(out) {
    const d = out.data, A = out.dims[2];
    let bestA = -1, bestConf = 0;
    for (let a = 0; a < A; a++) { const pc = d[4 * A + a]; if (pc > bestConf) { bestConf = pc; bestA = a; } }
    if (bestA < 0 || bestConf < POSE_PCONF) return { person: false, bothHands: false };
    const lw = d[(7 + 9 * 3) * A + bestA];   // punho esq. (kp 9, conf)
    const rw = d[(7 + 10 * 3) * A + bestA];  // punho dir. (kp 10, conf)
    return { person: true, leftWrist: lw, rightWrist: rw, bothHands: lw >= KP_CONF && rw >= KP_CONF };
}

// Recorta um quadrado do frame rgb24 (letterboxed 640x640) e amplia para
// IMGSZ×IMGSZ com interpolação bilinear — entrada da re-verificação com zoom.
function cropZoomTensor(frameBuf, box) {
    const [x1, y1, x2, y2] = box;
    const side = Math.min(IMGSZ, Math.max(PHONE_ZOOM_MIN, Math.round(Math.max(x2 - x1, y2 - y1) * PHONE_ZOOM)));
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const ox = Math.max(0, Math.min(IMGSZ - side, Math.round(cx - side / 2)));
    const oy = Math.max(0, Math.min(IMGSZ - side, Math.round(cy - side / 2)));
    const HW = IMGSZ * IMGSZ;
    const f = new Float32Array(3 * HW);
    const scale = side / IMGSZ;
    for (let y = 0; y < IMGSZ; y++) {
        const sy = Math.min(side - 1.001, y * scale), y0 = Math.floor(sy), fy = sy - y0;
        for (let x = 0; x < IMGSZ; x++) {
            const sx = Math.min(side - 1.001, x * scale), x0 = Math.floor(sx), fx = sx - x0;
            const p00 = ((oy + y0) * IMGSZ + (ox + x0)) * 3;
            const p01 = p00 + 3;
            const p10 = p00 + IMGSZ * 3;
            const p11 = p10 + 3;
            const i = y * IMGSZ + x;
            for (let c = 0; c < 3; c++) {
                const v = frameBuf[p00 + c] * (1 - fx) * (1 - fy) + frameBuf[p01 + c] * fx * (1 - fy)
                        + frameBuf[p10 + c] * (1 - fx) * fy + frameBuf[p11 + c] * fx * fy;
                f[c * HW + i] = v / 255;
            }
        }
    }
    return new ort.Tensor("float32", f, [1, 3, IMGSZ, IMGSZ]);
}

// 2ª passada: o box de celular sobrevive ao zoom? (mão gesticulando → some;
// celular real → confiança igual ou maior). Sem exigência de área: a 1ª passada
// já barrou objetos pequenos (relógio) e no recorte ampliado a área não compara.
async function verifyPhoneZoom(detectSession, frameBuf, phoneBoxes) {
    for (const p of phoneBoxes) {
        const out = await infer(detectSession, cropZoomTensor(frameBuf, p.box));
        const d = out.data, A = out.dims[2], NC = out.dims[1] - 4;
        for (let a = 0; a < A; a++) {
            let best = -1, bc = 0;
            for (let k = 0; k < NC; k++) { const s = d[(4 + k) * A + a]; if (s > bc) { bc = s; best = k; } }
            if (best === 67 && bc >= PHONE_CONF) return true;
        }
    }
    return false;
}

// Duração REAL do vídeo, em segundos. Não dá para usar `ffprobe -show_entries
// format=duration`: os arquivos vêm do MediaRecorder do navegador e o contêiner
// WebM sai sem duração no cabeçalho (duration=N/A). O jeito confiável é remuxar
// sem decodificar (-c copy) e ler o último `time=` — é rápido (milhares de vezes
// o tempo real) porque não decodifica quadro nenhum.
// Retorna null se não der para determinar (aí a análise cai no modo antigo).
function probeDurationSec(videoPath) {
    return new Promise((resolve) => {
        let ff;
        try { ff = spawn("ffmpeg", ["-hide_banner", "-i", videoPath, "-c", "copy", "-f", "null", "-"]); }
        catch { return resolve(null); }
        let err = "";
        ff.stderr.on("data", c => err += c.toString());
        ff.on("error", () => resolve(null));
        ff.on("close", () => {
            const m = [...String(err).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
            if (!m) return resolve(null);
            const sec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
            resolve(Number.isFinite(sec) && sec > 0 ? sec : null);
        });
    });
}

// ffmpeg → frames rgb24 640x640 letterboxed (cinza 0x727272 igual ao YOLO).
// `intervalSec` é o passo de amostragem (1 s no caso comum; maior em vídeo longo).
function extractFrames(videoPath, intervalSec = FRAME_SEC) {
    return new Promise((resolve, reject) => {
        const vf = `fps=1/${intervalSec},scale=${IMGSZ}:${IMGSZ}:force_original_aspect_ratio=decrease,pad=${IMGSZ}:${IMGSZ}:(ow-iw)/2:(oh-ih)/2:color=0x727272,format=rgb24`;
        const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-vf", vf, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
        const chunks = []; let errBuf = "";
        ff.stdout.on("data", c => chunks.push(c));
        ff.stderr.on("data", c => errBuf += c.toString());
        ff.on("error", reject);
        ff.on("close", code => {
            if (code !== 0) return reject(new Error(`ffmpeg saiu ${code}: ${errBuf.slice(0, 300)}`));
            const buf = Buffer.concat(chunks);
            const frameSize = IMGSZ * IMGSZ * 3;
            const frames = [];
            for (let off = 0; off + frameSize <= buf.length && frames.length < FRAME_BUDGET; off += frameSize)
                frames.push(buf.subarray(off, off + frameSize));
            resolve(frames);
        });
    });
}

// Proctoring de MÃOS via sidecar Python (MediaPipe). Roda pós-prova, isolado, e
// falha em silêncio (python/mediapipe ausente → sem flag de mãos, não quebra o
// resto). PROCTOR_PYTHON aponta o interpretador (com mediapipe); default "python".
function runHandsSidecar(videoPath) {
    return new Promise((resolve) => {
        const py = process.env.PROCTOR_PYTHON || "python";
        const script = path.join(PROJECT_ROOT, "scripts", "proctor_hands.py");
        let pr;
        try { pr = spawn(py, [script, videoPath]); } catch { return resolve(null); }
        let out = "", err = "";
        pr.stdout.on("data", d => out += d);
        pr.stderr.on("data", d => err += d);
        pr.on("error", () => resolve(null));
        pr.on("close", code => {
            if (code !== 0) { log.warn("PROCTOR", `hands sidecar code=${code}: ${String(err).slice(0, 150)}`); return resolve(null); }
            try { const j = JSON.parse(String(out).trim().split("\n").filter(Boolean).pop()); resolve(j && !j.error ? j : null); }
            catch { resolve(null); }
        });
    });
}

// Portão de SETUP: avalia UMA imagem (frame da câmera) contra a posição canônica
// (sidecar Python, MediaPipe Pose+Hands). Falha em silêncio se python ausente.
// (O portão de SETUP de posição migrou para o NAVEGADOR — MediaPipe WASM em
// static/oral-student.html. A análise de vídeo PÓS-prova abaixo segue no servidor.)

// Analisa um arquivo de vídeo local → resumo de flags (núcleo reutilizável).
export async function analyzeVideoFile(videoPath) {
    const t0 = Date.now();
    const s = await sessions();
    if (!s) throw new Error("proctoring de vídeo indisponível: onnxruntime-node não carregou neste ambiente");
    const { detect } = s;
    // Intervalo ADAPTATIVO: gasta o orçamento de quadros ao longo do vídeo inteiro.
    // Vídeo que cabe no orçamento continua a 1 s/quadro (nada muda); vídeo longo
    // estica o passo em vez de ser truncado no meio (#249).
    const durationSec = await probeDurationSec(videoPath);
    const intervalSec = durationSec
        ? Math.max(FRAME_SEC, Math.round((durationSec / FRAME_BUDGET) * 100) / 100)
        : FRAME_SEC;
    const frames = await extractFrames(videoPath, intervalSec);
    const per = [];
    let phoneRaw = 0;
    for (let i = 0; i < frames.length; i++) {
        const t = frameToTensor(frames[i]);
        const det = parseDetect(await infer(detect, t));
        let phone = false;
        if (det.phoneBoxes.length) {
            phoneRaw++;
            phone = await verifyPhoneZoom(detect, frames[i], det.phoneBoxes);
        }
        per.push({ sec: Math.round(i * intervalSec * 10) / 10, persons: det.persons, phone });
    }
    const n = per.length || 1;
    const absent = per.filter(f => f.persons === 0);
    const multiple = per.filter(f => f.persons >= 2);
    const phone = per.filter(f => f.phone);
    // Persistência: maior sequência CONTÍGUA (em segundos). Braço/gesto do próprio
    // aluno vira "2ª pessoa" por 1-2s; pessoa real fica. O MESMO raciocínio vale
    // para celular (#245): 23 segundos ESPALHADOS ao longo de 11 min é a assinatura
    // do falso positivo que o verifyPhoneZoom combate (gesticular lido como
    // aparelho); 15 segundos SEGUIDOS é alguém com o telefone na mão.
    // `at` é truncado nos 8 primeiros carimbos, então isto TEM de ser calculado
    // aqui — não dá para reconstruir a sequência a partir do relatório salvo.
    let multiRun = 0, run = 0;
    for (const f of per) { run = f.persons >= 2 ? run + intervalSec : 0; if (run > multiRun) multiRun = run; }
    let phoneRun = 0, pRun = 0;
    for (const f of per) { pRun = f.phone ? pRun + intervalSec : 0; if (pRun > phoneRun) phoneRun = pRun; }
    const pct = arr => Math.round((arr.length / n) * 100);
    const stamps = arr => arr.slice(0, 8).map(f => f.sec);
    // `count` é em QUADROS; `count_sec` converte para segundos pelo intervalo real
    // (iguais quando o intervalo é 1 s, que é o caso comum).
    const secs = arr => Math.round(arr.length * intervalSec);
    const coveredSec = Math.round(per.length * intervalSec);
    const summary = {
        frames: per.length,
        interval_sec: intervalSec,
        video_duration_s: durationSec ? Math.round(durationSec) : null,
        covered_s: coveredSec,
        // Só fica true se, mesmo com o passo esticado, o orçamento acabou antes do
        // fim do vídeo — ou se a duração não pôde ser medida e o corte antigo valeu.
        truncated: durationSec ? coveredSec < Math.round(durationSec) - intervalSec : per.length >= FRAME_BUDGET,
        duration_unknown: !durationSec,
        flags: {
            absent: { count: absent.length, count_sec: secs(absent), pct: pct(absent), at: stamps(absent) },
            multiple_people: { count: multiple.length, count_sec: secs(multiple), pct: pct(multiple), at: stamps(multiple), max_run_sec: multiRun },
            phone: { count: phone.length, count_sec: secs(phone), pct: pct(phone), at: stamps(phone), max_run_sec: Math.round(phoneRun), raw_count: phoneRaw },
        },
        analyzed_at: new Date().toISOString(),
        model: "yolov8n (onnxruntime, local)",
        ms: Date.now() - t0,
    };
    // Mãos + ENQUADRAMENTO (MediaPipe, sidecar Python). Novo formato: {hands, framing};
    // aceita o formato antigo "plano" (só mãos) por compatibilidade.
    const side = await runHandsSidecar(videoPath);
    if (side) {
        const h = side.hands || side;
        if (h && h.present_pct != null) {
            summary.flags.hands = {
                present_pct: h.present_pct, absent_pct: h.absent_pct,
                max_absence_sec: h.max_absence_sec, flag: !!h.flag, at: h.at || [],
            };
        }
        if (side.framing) {
            summary.flags.framing = {
                well_pct: side.framing.well_pct, bad_pct: side.framing.bad_pct,
                max_bad_sec: side.framing.max_bad_sec, flag: !!side.framing.flag, at: side.framing.at || [],
            };
        }
        summary.model += " + mediapipe hands/pose";
    }
    summary.ms = Date.now() - t0;
    return summary;
}

// Baixa o vídeo do object storage para um temp e analisa.
export async function analyzeOralVideo(videoKey) {
    if (!videoKey) throw new Error("sem vídeo para analisar");
    const ext = videoKey.split(".").pop() || "webm";
    const tmp = path.join(os.tmpdir(), `oralproctor-${crypto.randomBytes(6).toString("hex")}.${ext}`);
    const stream = await streamAudio(videoKey);
    if (!stream) throw new Error("vídeo indisponível no armazenamento");
    await new Promise((res, rej) => {
        const ws = fs.createWriteStream(tmp);
        stream.on("error", rej); ws.on("error", rej); ws.on("finish", res);
        stream.pipe(ws);
    });
    try {
        const r = await analyzeVideoFile(tmp);
        const ph = r.flags?.phone || {};
        log.info("PROCTOR", `analisado key=${videoKey} frames=${r.frames} passo=${r.interval_sec}s cobertura=${r.covered_s}s/${r.video_duration_s ?? "?"}s${r.truncated ? " TRUNCADO" : ""} ms=${r.ms} celular_bruto=${ph.raw_count ?? 0} celular_confirmado=${ph.count ?? 0}`);
        return r;
    } finally {
        fs.unlink(tmp, () => {});
    }
}

// Proctoring de MÚLTIPLAS partes (original + retomadas): analisa cada segmento e
// mescla num relatório único — soma frames, recomputa pct sobre o total e concatena
// os timestamps com offset pelo tempo acumulado dos segmentos anteriores.
export async function analyzeOralVideoParts(videoKeys) {
    const keys = (videoKeys || []).filter(Boolean);
    if (!keys.length) throw new Error("sem vídeo para analisar");
    if (keys.length === 1) return analyzeOralVideo(keys[0]);
    const parts = [];
    for (const k of keys) parts.push(await analyzeOralVideo(k));
    const totalFrames = parts.reduce((a, p) => a + (p.frames || 0), 0) || 1;
    // Cada parte tem o SEU intervalo (vídeo longo estica o passo), então o
    // deslocamento de tempo entre partes usa a duração coberta de cada uma —
    // não um intervalo único multiplicado pelo total de quadros.
    const partInterval = p => p.interval_sec || FRAME_SEC;
    const partCovered = p => (p.covered_s != null ? p.covered_s : (p.frames || 0) * partInterval(p));
    const mergeFlag = (name) => {
        let count = 0, countSec = 0; const at = []; let off = 0;
        for (const p of parts) {
            const f = p.flags?.[name];
            if (f) {
                count += f.count || 0;
                countSec += f.count_sec != null ? f.count_sec : Math.round((f.count || 0) * partInterval(p));
                for (const s of (f.at || [])) at.push(Math.round((off + s) * 10) / 10);
            }
            off += partCovered(p);
        }
        return { count, count_sec: countSec, pct: Math.round((count / totalFrames) * 100), at: at.slice(0, 12) };
    };
    const durations = parts.map(p => p.video_duration_s);
    // Mapa parte → janela de tempo GLOBAL. Os carimbos do relatório são globais
    // (offset acumulado), mas cada arquivo tem tempo próprio: sem isto, clicar num
    // trecho de uma sessão fragmentada procura o segundo global dentro da parte
    // errada. O painel usa isto para escolher a parte e converter para o tempo local.
    let spanOff = 0;
    const partSpans = parts.map((p, i) => {
        const dur = partCovered(p);
        const span = { part: i, offset_s: Math.round(spanOff), covered_s: Math.round(dur) };
        spanOff += dur;
        return span;
    });
    const summary = {
        part_spans: partSpans,
        frames: totalFrames,
        interval_sec: Math.max(...parts.map(partInterval)),
        video_duration_s: durations.some(d => d == null) ? null : Math.round(durations.reduce((a, d) => a + d, 0)),
        covered_s: Math.round(parts.reduce((a, p) => a + partCovered(p), 0)),
        truncated: parts.some(p => p.truncated),
        duration_unknown: parts.some(p => p.duration_unknown),
        parts: keys.length,
        flags: {
            absent: mergeFlag("absent"),
            multiple_people: {
                ...mergeFlag("multiple_people"),
                max_run_sec: Math.max(...parts.map(p => p.flags?.multiple_people?.max_run_sec || 0)),
            },
            phone: {
                ...mergeFlag("phone"),
                // Sequência contígua NÃO atravessa partes: a câmera caiu entre elas.
                max_run_sec: Math.max(...parts.map(p => p.flags?.phone?.max_run_sec || 0)),
                raw_count: parts.reduce((a, p) => a + (p.flags?.phone?.raw_count || 0), 0),
            },
        },
        analyzed_at: new Date().toISOString(),
        model: parts[0].model,
        ms: parts.reduce((a, p) => a + (p.ms || 0), 0),
    };
    // Mãos: média ponderada por frames; ausência máxima e flag agregados.
    const wh = parts.filter(p => p.flags?.hands);
    if (wh.length) {
        const fr = wh.reduce((a, p) => a + (p.frames || 0), 0) || 1;
        const wsum = (sel) => wh.reduce((a, p) => a + (p.flags.hands[sel] || 0) * (p.frames || 0), 0);
        summary.flags.hands = {
            present_pct: Math.round(wsum("present_pct") / fr),
            absent_pct: Math.round(wsum("absent_pct") / fr),
            max_absence_sec: Math.max(...wh.map(p => p.flags.hands.max_absence_sec || 0)),
            flag: wh.some(p => p.flags.hands.flag),
            at: [],
        };
    }
    return summary;
}

// CLI: node lib/proctor.js <video.mp4>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    analyzeVideoFile(process.argv[2]).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1); });
}

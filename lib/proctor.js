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

const IMGSZ = 640;
const DET_CONF = 0.40;   // confiança mínima (pessoa)
const IOU = 0.45;
const POSE_PCONF = 0.50; // confiança mínima da pessoa (pose)
const KP_CONF = 0.30;    // confiança do punho p/ "visível" — baixo de propósito:
                         // mãos cruzadas/parciais/perto da borda dão conf baixa mas
                         // ESTÃO visíveis. Só mão fora do quadro cai perto de 0.
const FRAME_SEC = 3;     // 1 frame a cada N segundos
const MAX_FRAMES = 400;  // trava de segurança
// Celular: mais rígido para não confundir relógio/smartwatch/objeto escuro com
// telefone. Exige confiança alta E área mínima do bounding box (relógio é pequeno).
const PHONE_CONF = 0.60;
const PHONE_MIN_AREA = 0.015; // 1,5% da área do frame

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
    return { persons: nms(persons, IOU).length, phone: nms(phones, IOU).length > 0 };
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

// ffmpeg → frames rgb24 640x640 letterboxed (cinza 0x727272 igual ao YOLO).
function extractFrames(videoPath) {
    return new Promise((resolve, reject) => {
        const vf = `fps=1/${FRAME_SEC},scale=${IMGSZ}:${IMGSZ}:force_original_aspect_ratio=decrease,pad=${IMGSZ}:${IMGSZ}:(ow-iw)/2:(oh-ih)/2:color=0x727272,format=rgb24`;
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
            for (let off = 0; off + frameSize <= buf.length && frames.length < MAX_FRAMES; off += frameSize)
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
    const frames = await extractFrames(videoPath);
    const per = [];
    for (let i = 0; i < frames.length; i++) {
        const t = frameToTensor(frames[i]);
        const det = parseDetect(await infer(detect, t));
        per.push({ sec: i * FRAME_SEC, persons: det.persons, phone: det.phone });
    }
    const n = per.length || 1;
    const absent = per.filter(f => f.persons === 0);
    const multiple = per.filter(f => f.persons >= 2);
    const phone = per.filter(f => f.phone);
    const pct = arr => Math.round((arr.length / n) * 100);
    const stamps = arr => arr.slice(0, 8).map(f => f.sec);
    const summary = {
        frames: per.length,
        interval_sec: FRAME_SEC,
        flags: {
            absent: { count: absent.length, pct: pct(absent), at: stamps(absent) },
            multiple_people: { count: multiple.length, pct: pct(multiple), at: stamps(multiple) },
            phone: { count: phone.length, pct: pct(phone), at: stamps(phone) },
        },
        analyzed_at: new Date().toISOString(),
        model: "yolov8n (onnxruntime, local)",
        ms: Date.now() - t0,
    };
    // Mãos (MediaPipe, sidecar Python): presença + ausência sustentada.
    const hands = await runHandsSidecar(videoPath);
    if (hands) {
        summary.flags.hands = {
            present_pct: hands.present_pct,
            absent_pct: hands.absent_pct,
            max_absence_sec: hands.max_absence_sec,
            flag: !!hands.flag,
            at: hands.at || [],
        };
        summary.model += " + mediapipe hands";
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
        log.info("PROCTOR", `analisado key=${videoKey} frames=${r.frames} ms=${r.ms}`);
        return r;
    } finally {
        fs.unlink(tmp, () => {});
    }
}

// CLI: node lib/proctor.js <video.mp4>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    analyzeVideoFile(process.argv[2]).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1); });
}

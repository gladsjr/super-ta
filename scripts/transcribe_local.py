#!/usr/bin/env python3
"""Motor LOCAL de retranscrição (faster-whisper) — issue #289, corte 3.

Chamado pelo executor de jobs (lib/jobRunner.js) via spawnLow (nice 19 +
OMP_NUM_THREADS=1). Carrega o modelo UMA vez e transcreve o arquivo inteiro
ou, se receber --spans, cada trecho (clip_timestamps) — modelo carregado uma
única vez para todos os trechos.

Saída: UMA linha JSON no stdout:
  sem spans:  {"mode":"continuous","text":"...", "segments":[{start,end,text}]}
  com spans:  {"mode":"spans","results":[{"start_s":..,"end_s":..,"text":".."}]}
Erro: exit != 0 com a mensagem no stderr (o executor cai no motor de API).

Requisitos na VM: python3 + `pip install faster-whisper` (o modelo
large-v3-turbo baixa ~1.6GB no primeiro uso, fica em cache).
Validado na bancada de 21/08: 0,69x o tempo real em CPU int8; recuperou o
caso Rebeca melhor que a API.
"""
import argparse
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--language", default="pt")
    ap.add_argument("--prompt", default=None)          # glossário (initial_prompt)
    ap.add_argument("--spans", default=None)           # JSON [[start_s, end_s], ...]
    ap.add_argument("--model", default="large-v3-turbo")
    args = ap.parse_args()

    from faster_whisper import WhisperModel  # import tardio: erro claro se ausente

    # cpu_threads=1: o teto de threads do corte 3 — o batch nunca ocupa a máquina.
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=1)

    common = dict(language=args.language, beam_size=5)
    if args.prompt:
        common["initial_prompt"] = args.prompt

    if args.spans:
        spans = json.loads(args.spans)
        clips = [f"{s},{e}" for s, e in spans]
        segs, _info = model.transcribe(args.audio, clip_timestamps=",".join(clips), **common)
        segs = list(segs)
        # Reatribui cada segmento do whisper ao span pedido (por sobreposição).
        results = [{"start_s": s, "end_s": e, "text": ""} for s, e in spans]
        for seg in segs:
            mid = (seg.start + seg.end) / 2
            for r in results:
                if r["start_s"] <= mid <= r["end_s"]:
                    r["text"] = (r["text"] + " " + seg.text.strip()).strip()
                    break
        print(json.dumps({"mode": "spans", "results": results}, ensure_ascii=False))
    else:
        segs, _info = model.transcribe(args.audio, **common)
        segs = list(segs)
        out = {
            "mode": "continuous",
            "text": " ".join(s.text.strip() for s in segs),
            "segments": [{"start": round(s.start, 1), "end": round(s.end, 1), "text": s.text.strip()} for s in segs],
        }
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — o executor lê o stderr e degrada p/ API
        print(f"transcribe_local: {e}", file=sys.stderr)
        sys.exit(1)

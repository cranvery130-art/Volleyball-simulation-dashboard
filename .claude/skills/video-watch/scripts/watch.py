#!/usr/bin/env python3
"""경기 영상 파일을 Claude가 읽을 수 있는 장면 사진 + 모아보기로 바꿔요.

원본: moongiadventures-dev/moongi-video-skills 의 video-watch (MIT, 같은 폴더 LICENSE).
배구 경기 기록용으로 고친 점:
- 내 PC에 있는 영상 파일만 받아요(유튜브 등 링크 내려받기 기능은 뺐어요).
- 작성자 PC에 박혀 있던 실행 경로를 없앴어요.
- 영상 길이를 ffprobe로 재고, --start/--end 로 랠리 한 구간만 볼 수 있어요.
- 장면 간격을 0.5초처럼 소수로 줄 수 있어요(기본은 길이에 맞춰 자동).
- 소리 받아쓰기(Whisper)는 --whisper 를 줄 때만 해요(체육관 소리는 대부분 호루라기·함성).

필요한 것: ffmpeg/ffprobe, Pillow. --whisper 는 faster-whisper 가 있어야 해요.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_CACHE = Path.home() / ".claude" / "video-watch"


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")


def hms(seconds):
    seconds = float(seconds)
    whole = int(seconds)
    h, rem = divmod(whole, 3600)
    m, s = divmod(rem, 60)
    tenth = int(round((seconds - whole) * 10))
    if tenth == 10:
        return hms(whole + 1)
    tail = f".{tenth}" if tenth else ""
    return f"{h:d}:{m:02d}:{s:02d}{tail}" if h else f"{m:02d}:{s:02d}{tail}"


def parse_time(text):
    """'95', '95.5', '1:35', '0:01:35' -> 초."""
    if text is None:
        return None
    parts = str(text).strip().split(":")
    sec = 0.0
    for p in parts:
        sec = sec * 60 + float(p)
    return sec


def probe_duration(video):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=noprint_wrappers=1:nokey=1", str(video)]).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


# ---------- 장면 ----------

def extract_frames(video, outdir, start, end, interval, width):
    frames_dir = outdir / "frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)
    run([
        "ffmpeg", "-nostdin", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(video),
        "-vf", f"fps=1/{interval},scale={width}:-2",
        "-q:v", "4", str(frames_dir / "f_%05d.jpg"),
    ])
    out = []
    for i, f in enumerate(sorted(frames_dir.glob("f_*.jpg"))):
        t = start + i * interval
        if t > end + 1e-6:
            f.unlink()
            continue
        dst = frames_dir / f"{int(t * 10):07d}ds_{hms(t).replace(':', '-')}.jpg"
        f.rename(dst)
        out.append((t, dst))
    return out


def _font(size):
    from PIL import ImageFont
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow 10.1 이전
        return ImageFont.load_default()


def contact_sheets(frames, outdir, cols=3, rows=3):
    from PIL import Image, ImageDraw
    sheets_dir = outdir / "sheets"
    if sheets_dir.exists():
        shutil.rmtree(sheets_dir)
    sheets_dir.mkdir(parents=True)
    per = cols * rows
    font = _font(24)
    made = []
    for n in range(0, len(frames), per):
        chunk = frames[n:n + per]
        thumbs = [(t, Image.open(p).convert("RGB")) for t, p in chunk]
        tw, th = thumbs[0][1].size
        bar = 34
        sheet = Image.new("RGB", (cols * tw, rows * (th + bar)), "black")
        draw = ImageDraw.Draw(sheet)
        for i, (t, im) in enumerate(thumbs):
            c, r = i % cols, i // cols
            x, y = c * tw, r * (th + bar)
            sheet.paste(im, (x, y))
            draw.text((x + 8, y + th + 4), f"[{hms(t)}]", fill="white", font=font)
        dst = sheets_dir / f"sheet_{n // per + 1:02d}.jpg"
        sheet.save(dst, quality=85)
        made.append(dst)
    return made


# ---------- 소리(선택) ----------

def whisper_transcribe(video, start, end, model_size):
    from faster_whisper import WhisperModel  # PC 안에서만 처리, 외부 전송 없음
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(video), language="ko", vad_filter=True,
                                   clip_timestamps=[start, end])
    return [(seg.start, seg.text.strip()) for seg in segments if seg.text.strip()]


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description="경기 영상 파일을 장면 사진과 모아보기로 바꿔요.")
    ap.add_argument("source", help="내 PC에 있는 영상 파일 경로")
    ap.add_argument("--outdir", help="결과 폴더 (기본: ~/.claude/video-watch/<파일이름>)")
    ap.add_argument("--start", help="시작 시각 (초 또는 분:초)")
    ap.add_argument("--end", help="끝 시각 (초 또는 분:초)")
    ap.add_argument("--interval", type=float, default=0, help="장면 간격(초, 0.5 같은 소수 가능, 0=자동)")
    ap.add_argument("--max-frames", type=int, default=60, help="장면 수 상한 (기본 60)")
    ap.add_argument("--width", type=int, default=960, help="장면 가로 크기 px (등번호가 작으면 키우기)")
    ap.add_argument("--whisper", action="store_true", help="소리도 받아쓰기 (faster-whisper 필요)")
    ap.add_argument("--model", default="base", help="whisper 모델: tiny/base/small/medium")
    args = ap.parse_args()

    if re.match(r"^[a-z]+://", args.source, re.I):
        sys.exit("링크는 받지 않아요. 내 PC에 있는 경기 영상 파일 경로를 넣어 주세요.")
    video = Path(args.source)
    if not video.is_file():
        sys.exit(f"영상 파일을 찾지 못했어요: {video}")

    duration = probe_duration(video)
    start = max(0.0, parse_time(args.start) or 0.0)
    end = parse_time(args.end) if args.end else duration
    if duration:
        end = min(end, duration)
    if end <= start:
        sys.exit(f"구간이 잘못됐어요: 시작 {hms(start)}, 끝 {hms(end)} (영상 길이 {hms(duration)})")
    span = end - start
    interval = args.interval or max(1.0, round(span / args.max_frames, 1))

    tag = f"_{int(start)}-{int(end)}" if (args.start or args.end) else ""
    outdir = Path(args.outdir) if args.outdir else DEFAULT_CACHE / (re.sub(r"[^\w.-]", "_", video.stem) + tag)
    outdir.mkdir(parents=True, exist_ok=True)

    frames = extract_frames(video, outdir, start, end, interval, args.width)
    if len(frames) > args.max_frames:  # 고르게 골라 남기기
        step = len(frames) / args.max_frames
        keep = {frames[int(i * step)][1] for i in range(args.max_frames)}
        for _, p in frames:
            if p not in keep:
                p.unlink()
        frames = [(t, p) for t, p in frames if p in keep]
    sheets = contact_sheets(frames, outdir) if frames else []

    cues = whisper_transcribe(video, start, end, args.model) if args.whisper else []
    if cues:
        md = [f"# {video.name} 소리 받아쓰기 ({hms(start)}~{hms(end)})", ""]
        md += [f"**[{hms(t)}]** {text}" for t, text in cues]
        (outdir / "transcript.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    meta = {"file": str(video.resolve()), "duration": round(duration, 1),
            "start": round(start, 1), "end": round(end, 1), "interval": interval}
    (outdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({
        "outdir": str(outdir),
        "range": f"{hms(start)}~{hms(end)}",
        "duration": hms(duration) if duration else "?",
        "interval_sec": interval,
        "frames": len(frames),
        "sheets": [str(s) for s in sheets],
        "transcript": str(outdir / "transcript.md") if cues else None,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

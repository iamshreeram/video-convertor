#!/usr/bin/env bash
# Real-world validation of the MKV -> MP4 converter against ffmpeg/ffprobe.
#
# Usage: scripts/validate.sh [fixtures_dir] [ffmpeg] [ffprobe]
#   defaults: /tmp/mkvtools/fixtures /tmp/mkvtools/ffmpeg /tmp/mkvtools/ffprobe
#
# Requires `bash scripts/build.sh --node` first (node-smoke loads dist-node/).
# For every *.mkv in fixtures_dir: convert with node-smoke, then check
#   convert, decode, streams, packet-count, packet-timing, duration,
#   video-start, framemd5, audio-length, audio-first1s.
# Files named truncated*.mkv only get the convert and decode checks.
# Prints one PASS/FAIL/SKIP line per check and a summary; exits 1 on any FAIL.
# Bash 3.2 compatible (macOS); python3 is used only for numeric comparisons.

set -u

repo="$(cd "$(dirname "$0")/.." && pwd)"
fixtures_dir="${1:-/tmp/mkvtools/fixtures}"
ffmpeg_bin="${2:-/tmp/mkvtools/ffmpeg}"
ffprobe_bin="${3:-/tmp/mkvtools/ffprobe}"
smoke="$repo/scripts/node-smoke.mjs"

pass=0
fail=0
skip=0
fixture_count=0
truncated_names=""

tmp="$(mktemp -d "${TMPDIR:-/tmp}/mkvval.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# report STATUS FIXTURE CHECK [DETAIL]
report() {
  case "$1" in
    PASS) pass=$((pass + 1)) ;;
    FAIL) fail=$((fail + 1)) ;;
    SKIP) skip=$((skip + 1)) ;;
  esac
  printf '%s  %-16s %-14s %s\n' "$1" "$2" "$3" "${4:-}"
}

# probe OUTFILE ARGS... (input file last); ffprobe stderr kept in OUTFILE.err.
# ffprobe 4.4 prints stray blank lines after some MP4 AC-3 streams; drop them
# so csv comparisons see only data rows.
probe() {
  local dest="$1"
  shift
  local rc
  "$ffprobe_bin" -v error "$@" >"$dest.raw" 2>"$dest.err"
  rc=$?
  grep -v '^$' "$dest.raw" >"$dest"
  return $rc
}

sha_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

size_of() {
  wc -c <"$1" | tr -d ' '
}

write_helpers() {
  cat >"$tmp/helpers.py" <<'PY'
import sys

PTS_TOL = 0.0011


def load(path):
    streams = {}
    with open(path) as fh:
        for line in fh:
            f = line.strip().split(',')
            if len(f) < 4:
                continue
            idx = f[0]
            s = streams.setdefault(idx, {'pts': [], 'key': []})
            s['pts'].append(f[1])
            s['key'].append('K' in f[3])
    return streams


def packets(a, b):
    src = load(a)
    out = load(b)
    problems = []
    if sorted(src) != sorted(out):
        problems.append('stream sets differ src=%s out=%s' % (sorted(src), sorted(out)))
    maxd = 0.0
    for idx in sorted(set(src) & set(out)):
        sp, op = src[idx]['pts'], out[idx]['pts']
        if len(sp) != len(op):
            problems.append('stream %s packets %d vs %d' % (idx, len(sp), len(op)))
            continue
        try:
            sa = sorted(float(x) for x in sp)
            oa = sorted(float(x) for x in op)
        except ValueError:
            problems.append('stream %s non-numeric pts' % idx)
            continue
        d = max([abs(x - y) for x, y in zip(sa, oa)] or [0.0])
        maxd = max(maxd, d)
        if d > PTS_TOL:
            problems.append('stream %s pts max diff %.6f > %.4f' % (idx, d, PTS_TOL))
        sk, ok = src[idx]['key'], out[idx]['key']
        if sk != ok:
            first = [i for i, (x, y) in enumerate(zip(sk, ok)) if x != y]
            where = first[0] if first else min(len(sk), len(ok))
            problems.append('stream %s keyframe flags differ first at packet %d' % (idx, where))
    if problems:
        print('; '.join(problems))
        return 1
    print('streams=%d max_pts_diff=%.6f s' % (len(src), maxd))
    return 0


def within(a, b, tol):
    try:
        d = abs(float(a) - float(b))
    except ValueError:
        print('non-numeric value %r vs %r' % (a, b))
        return 1
    print('value=%s expected=%s diff=%.6f tol=%.4f' % (a, b, d, tol))
    return 0 if d <= tol else 1


def main():
    mode = sys.argv[1]
    if mode == 'packets':
        return packets(sys.argv[2], sys.argv[3])
    if mode == 'within':
        return within(sys.argv[2], sys.argv[3], float(sys.argv[4]))
    print('unknown mode %s' % mode)
    return 2


sys.exit(main())
PY
}

# check_decode FILE LABEL: full decode of every stream must be silent, exit 0.
check_decode() {
  local name="$1" file="$2" dir="$3"
  "$ffmpeg_bin" -v error -nostdin -i "$file" -f null - 2>"$dir/decode.err"
  local rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$dir/decode.err" ]; then
    report PASS "$name" decode "ffmpeg exit 0, stderr empty"
    return 0
  fi
  report FAIL "$name" decode "rc=$rc stderr_lines=$(wc -l <"$dir/decode.err" | tr -d ' ') first: $(head -n1 "$dir/decode.err")"
  return 1
}

validate_truncated() {
  local name="$1" file="$2" dir="$3" out="$4"
  truncated_names="$truncated_names $name"
  node "$smoke" "$file" "$out" >"$dir/smoke.json" 2>"$dir/smoke.err"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    report FAIL "$name" convert "node-smoke exit $rc: $(head -n1 "$dir/smoke.err")"
    return
  fi
  if grep -qi truncated "$dir/smoke.json"; then
    report PASS "$name" convert "exit 0, truncated warning present"
  else
    report FAIL "$name" convert "exit 0 but no 'truncated' warning in summary"
  fi
  check_decode "$name" "$out" "$dir"
}

validate_one() {
  local file="$1"
  local name dir out
  name="$(basename "$file" .mkv)"
  dir="$tmp/$name"
  mkdir -p "$dir"
  out="$dir/out.mp4"
  fixture_count=$((fixture_count + 1))

  case "$name" in
    truncated*)
      validate_truncated "$name" "$file" "$dir" "$out"
      return
      ;;
  esac

  node "$smoke" "$file" "$out" >"$dir/smoke.json" 2>"$dir/smoke.err"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    report FAIL "$name" convert "node-smoke exit $rc: $(head -n1 "$dir/smoke.err")"
    return
  fi
  report PASS "$name" convert "exit 0"

  check_decode "$name" "$out" "$dir"

  # (3) stream parity: codec, type, geometry, audio format, in order.
  local fields="index,codec_name,codec_type,width,height,sample_rate,channels"
  if probe "$dir/src.streams" -show_entries "stream=$fields" -of csv=p=0 "$file" &&
    probe "$dir/out.streams" -show_entries "stream=$fields" -of csv=p=0 "$out"; then
    if cmp -s "$dir/src.streams" "$dir/out.streams"; then
      report PASS "$name" streams "$(tr '\n' ' ' <"$dir/out.streams")"
    else
      diff "$dir/src.streams" "$dir/out.streams" >"$dir/streams.diff"
      report FAIL "$name" streams "differ, see $dir/streams.diff"
    fi
  else
    report FAIL "$name" streams "ffprobe failed"
  fi

  # (4) per-stream packet count.
  if probe "$dir/src.count" -count_packets -show_entries stream=index,nb_read_packets -of csv=p=0 "$file" &&
    probe "$dir/out.count" -count_packets -show_entries stream=index,nb_read_packets -of csv=p=0 "$out"; then
    if cmp -s "$dir/src.count" "$dir/out.count"; then
      report PASS "$name" pkt-count "$(tr '\n' ' ' <"$dir/out.count")"
    else
      report FAIL "$name" pkt-count "src=[$(tr '\n' ' ' <"$dir/src.count")] out=[$(tr '\n' ' ' <"$dir/out.count")]"
    fi
  else
    report FAIL "$name" pkt-count "ffprobe failed"
  fi

  # (5) packet timing: pts multiset per stream (tol 1.1 ms) and keyframe order.
  local pkt_fields="stream_index,pts_time,dts_time,flags"
  if probe "$dir/src.pkts" -show_entries "packet=$pkt_fields" -of csv=p=0 "$file" &&
    probe "$dir/out.pkts" -show_entries "packet=$pkt_fields" -of csv=p=0 "$out"; then
    local msg
    msg="$(python3 "$tmp/helpers.py" packets "$dir/src.pkts" "$dir/out.pkts")"
    if [ $? -eq 0 ]; then
      report PASS "$name" pkt-timing "$msg"
    else
      report FAIL "$name" pkt-timing "$msg"
    fi
  else
    report FAIL "$name" pkt-timing "ffprobe failed"
  fi

  # (6) container duration within 60 ms; output video starts at 0 (1 ms).
  local src_dur out_dur msg
  if probe "$dir/src.dur" -show_entries format=duration -of csv=p=0 "$file" &&
    probe "$dir/out.dur" -show_entries format=duration -of csv=p=0 "$out"; then
    src_dur="$(head -n1 "$dir/src.dur")"
    out_dur="$(head -n1 "$dir/out.dur")"
    msg="$(python3 "$tmp/helpers.py" within "$out_dur" "$src_dur" 0.060)"
    if [ $? -eq 0 ]; then
      report PASS "$name" duration "$msg"
    else
      report FAIL "$name" duration "$msg"
    fi
  else
    report FAIL "$name" duration "ffprobe failed"
  fi

  if probe "$dir/out.vstart" -select_streams v:0 -show_entries stream=start_time -of csv=p=0 "$out"; then
    msg="$(python3 "$tmp/helpers.py" within "$(head -n1 "$dir/out.vstart")" 0 0.001)"
    if [ $? -eq 0 ]; then
      report PASS "$name" vstart-zero "$msg"
    else
      report FAIL "$name" vstart-zero "$msg"
    fi
  else
    report FAIL "$name" vstart-zero "ffprobe failed"
  fi

  # (7a) decoded video: framemd5 md5 sequences identical.
  local ok=1
  "$ffmpeg_bin" -v error -nostdin -i "$file" -map 0:v:0 -fps_mode passthrough -f framemd5 "$dir/src.md5" 2>"$dir/md5src.err" || ok=0
  "$ffmpeg_bin" -v error -nostdin -i "$out" -map 0:v:0 -fps_mode passthrough -f framemd5 "$dir/out.md5" 2>"$dir/md5out.err" || ok=0
  if [ "$ok" -eq 1 ]; then
    awk -F, '!/^#/ && NF { gsub(/ /, "", $NF); print $NF }' "$dir/src.md5" >"$dir/src.md5s"
    awk -F, '!/^#/ && NF { gsub(/ /, "", $NF); print $NF }' "$dir/out.md5" >"$dir/out.md5s"
    if [ -s "$dir/src.md5s" ] && cmp -s "$dir/src.md5s" "$dir/out.md5s"; then
      report PASS "$name" framemd5 "$(wc -l <"$dir/out.md5s" | tr -d ' ') frames identical"
    else
      report FAIL "$name" framemd5 "src_frames=$(wc -l <"$dir/src.md5s" | tr -d ' ') out_frames=$(wc -l <"$dir/out.md5s" | tr -d ' ') or md5 differ"
    fi
  else
    report FAIL "$name" framemd5 "ffmpeg framemd5 failed, see $dir/md5*.err"
  fi

  # (7b) decoded audio: first audio stream as s16le 48 kHz stereo.
  if ! probe "$dir/src.aidx" -select_streams a -show_entries stream=index -of csv=p=0 "$file"; then
    report FAIL "$name" audio "ffprobe failed on source"
    return
  fi
  if [ ! -s "$dir/src.aidx" ]; then
    report SKIP "$name" audio "no audio stream in source"
    return
  fi

  "$ffmpeg_bin" -v error -nostdin -i "$file" -map 0:a:0 -f s16le -ac 2 -ar 48000 "$dir/src.pcm" 2>"$dir/apcm-src.err"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    report FAIL "$name" audio-length "source audio decode rc=$rc"
    return
  fi
  "$ffmpeg_bin" -v error -nostdin -i "$out" -map 0:a:0 -f s16le -ac 2 -ar 48000 "$dir/out.pcm" 2>"$dir/apcm-out.err"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    report FAIL "$name" audio-length "output audio decode rc=$rc"
    return
  fi

  local src_len out_len diff
  src_len="$(size_of "$dir/src.pcm")"
  out_len="$(size_of "$dir/out.pcm")"
  diff=$((out_len - src_len))
  [ "$diff" -lt 0 ] && diff=$((-diff))
  if [ "$diff" -le 8192 ]; then
    report PASS "$name" audio-length "src=$src_len out=$out_len |diff|=$diff bytes (<=8192)"
  else
    report FAIL "$name" audio-length "src=$src_len out=$out_len |diff|=$diff bytes (>8192)"
  fi

  head -c 192000 "$dir/src.pcm" >"$dir/src1s.pcm"
  head -c 192000 "$dir/out.pcm" >"$dir/out1s.pcm"
  if [ "$(sha_of "$dir/src1s.pcm")" = "$(sha_of "$dir/out1s.pcm")" ]; then
    report PASS "$name" audio-first1s "first 1 s byte-identical (sha256)"
  else
    local first
    first="$(cmp "$dir/src1s.pcm" "$dir/out1s.pcm" 2>&1 | head -n1)"
    report FAIL "$name" audio-first1s "not identical: $first"
  fi
}

# ---- main ----

for tool in node python3 "$ffmpeg_bin" "$ffprobe_bin"; do
  if ! command -v "$tool" >/dev/null 2>&1 && [ ! -x "$tool" ]; then
    echo "validate.sh: missing tool: $tool" >&2
    exit 1
  fi
done
if [ ! -f "$smoke" ]; then
  echo "validate.sh: missing $smoke" >&2
  exit 1
fi

write_helpers

echo "validate.sh: fixtures=$fixtures_dir ffmpeg=$ffmpeg_bin ffprobe=$ffprobe_bin"
for file in "$fixtures_dir"/*.mkv; do
  if [ ! -f "$file" ]; then
    echo "FAIL no *.mkv files in $fixtures_dir"
    exit 1
  fi
  validate_one "$file"
done

echo
echo "SUMMARY fixtures=$fixture_count pass=$pass fail=$fail skip=$skip"
if [ -n "$truncated_names" ]; then
  echo "NOTE truncated fixtures checked for convert+decode only:$truncated_names"
fi
if [ "$fail" -eq 0 ]; then
  echo "RESULT PASS"
  exit 0
fi
echo "RESULT FAIL ($fail check(s) failed)"
exit 1

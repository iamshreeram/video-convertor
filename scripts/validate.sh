#!/usr/bin/env bash
# Real-world validation of the MKV -> MP4 converter against ffmpeg/ffprobe.
#
# Usage: scripts/validate.sh [fixtures_dir] [ffmpeg] [ffprobe]
#   defaults: /tmp/mkvtools/fixtures /tmp/mkvtools/ffmpeg /tmp/mkvtools/ffprobe
#
# Requires `bash scripts/build.sh --node` first (node-smoke loads dist-node/).
# For every *.mkv in fixtures_dir: convert with node-smoke, then check
#   convert, decode, streams, packet-count, pkt-timing, duration,
#   start-offsets, aspect, lang, framemd5, audio-length, audio-first1s.
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
from fractions import Fraction

PTS_TOL = 0.0011
START_TOL = 0.0011


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


def numbers(values):
    nums = []
    bad = 0
    for v in values:
        try:
            nums.append(float(v))
        except ValueError:
            bad += 1
    return nums, bad


def packets(a, b):
    src = load(a)
    out = load(b)
    problems = []
    if sorted(src) != sorted(out):
        problems.append('stream sets differ src=%s out=%s' % (sorted(src), sorted(out)))
    # Each file's timeline is shifted so the earliest packet of ANY stream is
    # at 0 (like ffmpeg -c copy); compare per-stream timing relative to that.
    mins = {}
    for label, streams in (('src', src), ('out', out)):
        allv = []
        for idx in sorted(streams):
            nums, bad = numbers(streams[idx]['pts'])
            if bad:
                problems.append('%s stream %s non-numeric pts' % (label, idx))
            allv.extend(nums)
        mins[label] = min(allv) if allv else 0.0
    maxd = 0.0
    for idx in sorted(set(src) & set(out)):
        sp, op = src[idx]['pts'], out[idx]['pts']
        if len(sp) != len(op):
            problems.append('stream %s packets %d vs %d' % (idx, len(sp), len(op)))
            continue
        sn, sbad = numbers(sp)
        on, obad = numbers(op)
        if sbad or obad:
            problems.append('stream %s non-numeric pts' % idx)
            continue
        sa = sorted(x - mins['src'] for x in sn)
        oa = sorted(x - mins['out'] for x in on)
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
    print('streams=%d max_pts_diff=%.6f s (rel. to earliest packet: src %.6f out %.6f)'
          % (len(src), maxd, mins['src'], mins['out']))
    return 0


def starts(path):
    rows = []
    with open(path) as fh:
        for line in fh:
            f = line.strip().split(',')
            if len(f) < 2:
                continue
            rows.append(f[1])
    return rows


def offsets(a, b):
    sv = starts(a)
    ov = starts(b)
    if len(sv) != len(ov):
        print('stream count %d vs %d' % (len(sv), len(ov)))
        return 1
    sn, sbad = numbers(sv)
    on, obad = numbers(ov)
    if sbad or obad or not sn:
        print('non-numeric or missing start_time src=%r out=%r' % (sv, ov))
        return 1
    smin = min(sn)
    omin = min(on)
    problems = []
    maxd = 0.0
    for i in range(len(sn)):
        d = abs((sn[i] - smin) - (on[i] - omin))
        maxd = max(maxd, d)
        if d > START_TOL:
            problems.append('stream %d offset src=%.6f out=%.6f' % (i, sn[i] - smin, on[i] - omin))
    if abs(omin) > 0.001:
        problems.append('min output start_time %.6f not 0 (1 ms)' % omin)
    if problems:
        print('; '.join(problems))
        return 1
    print('streams=%d out_min_start=%.6f max_offset_diff=%.6f s' % (len(sn), omin, maxd))
    return 0


def first_row(path):
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                return line.split(',')
    return []


def ratio(text):
    try:
        num, den = text.split(':')
        return Fraction(int(num), int(den))
    except (ValueError, ZeroDivisionError):
        return text


def aspect(a, b):
    sf = first_row(a)
    of = first_row(b)
    if len(sf) != 2 or len(of) != 2:
        print('unexpected ffprobe rows src=%r out=%r' % (sf, of))
        return 1
    names = ['sample_aspect_ratio', 'display_aspect_ratio']
    checked = []
    problems = []
    for name, s, o in zip(names, sf, of):
        if s in ('N/A', ''):
            continue
        checked.append('%s=%s' % (name, s))
        if ratio(s) != ratio(o):
            problems.append('%s src=%s out=%s' % (name, s, o))
    if not checked:
        print('source has no sample/display aspect ratio (N/A)')
        return 3
    if problems:
        print('; '.join(problems))
        return 1
    print('%s match' % ', '.join(checked))
    return 0


def langs(path):
    values = []
    with open(path) as fh:
        for line in fh:
            f = line.strip().split(',')
            if not f or not f[0]:
                continue
            values.append(f[1] if len(f) > 1 else '')
    return values


def lang(a, b):
    sv = langs(a)
    ov = langs(b)
    if len(sv) != len(ov):
        print('stream count %d vs %d' % (len(sv), len(ov)))
        return 1
    tagged = [i for i, x in enumerate(sv) if x]
    if not tagged:
        print('no language tags in source')
        return 3
    problems = ['stream %d src=%s out=%s' % (i, sv[i], ov[i]) for i in tagged if sv[i] != ov[i]]
    if problems:
        print('; '.join(problems))
        return 1
    print('tagged=%d %s' % (len(tagged), ' '.join('%d:%s' % (i, sv[i]) for i in tagged)))
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
    if mode == 'offsets':
        return offsets(sys.argv[2], sys.argv[3])
    if mode == 'aspect':
        return aspect(sys.argv[2], sys.argv[3])
    if mode == 'lang':
        return lang(sys.argv[2], sys.argv[3])
    print('unknown mode %s' % mode)
    return 2


sys.exit(main())
PY
}

# check_decode FILE LABEL: full decode of every stream must be silent, exit 0.
# check_decode FILE LABEL DIR SRC: full decode (ffmpeg -f null) must exit 0.
# Stderr must be empty, or contain only lines the SOURCE's decode also prints
# (ffmpeg 6 warns "non monotonically increasing dts" for some B-frame sources
# when re-encoding; a truncated source adds "File ended prematurely"). A
# converter must not add diagnostics of its own.
check_decode() {
  local name="$1" file="$2" dir="$3" src="$4"
  "$ffmpeg_bin" -v error -nostdin -i "$file" -f null - 2>"$dir/decode.err"
  local rc=$?
  "$ffmpeg_bin" -v error -nostdin -i "$src" -f null - 2>"$dir/decode-src.err"
  # ffmpeg log lines carry heap addresses that differ per run; strip them.
  sed 's/0x[0-9a-f]*//g' "$dir/decode.err" >"$dir/decode.norm"
  sed 's/0x[0-9a-f]*//g' "$dir/decode-src.err" >"$dir/decode-src.norm"
  local n_out n_src
  n_out="$(wc -l <"$dir/decode.norm" | tr -d ' ')"
  n_src="$(wc -l <"$dir/decode-src.norm" | tr -d ' ')"
  # Lines in the output's stderr that the source's stderr does not contain.
  grep -vxF -f "$dir/decode-src.norm" "$dir/decode.norm" >"$dir/decode.extra"
  if [ "$rc" -eq 0 ] && [ ! -s "$dir/decode.norm" ]; then
    report PASS "$name" decode "ffmpeg exit 0, stderr empty"
    return 0
  fi
  if [ "$rc" -eq 0 ] && [ ! -s "$dir/decode.extra" ]; then
    report PASS "$name" decode "ffmpeg exit 0; out_lines=$n_out all inherited from source (src_lines=$n_src)"
    return 0
  fi
  report FAIL "$name" decode "rc=$rc out_lines=$n_out src_lines=$n_src new=$(wc -l <"$dir/decode.extra" | tr -d ' ') first_new: $(head -n1 "$dir/decode.extra")"
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
  check_decode "$name" "$out" "$dir" "$file"
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

  check_decode "$name" "$out" "$dir" "$file"

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

  # (5) packet timing: per-stream pts multiset relative to each file's earliest
  # packet (tol 1.1 ms) and keyframe order.
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

  # (6) container duration within 60 ms.
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

  # (6b) start-offsets: each stream's start relative to the earliest stream
  # must match the source (1.1 ms); earliest output stream starts at 0 (1 ms).
  if probe "$dir/src.starts" -show_entries stream=index,start_time -of csv=p=0 "$file" &&
    probe "$dir/out.starts" -show_entries stream=index,start_time -of csv=p=0 "$out"; then
    msg="$(python3 "$tmp/helpers.py" offsets "$dir/src.starts" "$dir/out.starts")"
    if [ $? -eq 0 ]; then
      report PASS "$name" start-offsets "$msg"
    else
      report FAIL "$name" start-offsets "$msg"
    fi
  else
    report FAIL "$name" start-offsets "ffprobe failed"
  fi

  # (6c) video SAR/DAR must equal the source; SKIP when the source has none.
  if probe "$dir/src.aspect" -select_streams v:0 -show_entries stream=sample_aspect_ratio,display_aspect_ratio -of csv=p=0 "$file" &&
    probe "$dir/out.aspect" -select_streams v:0 -show_entries stream=sample_aspect_ratio,display_aspect_ratio -of csv=p=0 "$out"; then
    msg="$(python3 "$tmp/helpers.py" aspect "$dir/src.aspect" "$dir/out.aspect")"
    rc=$?
    case "$rc" in
      0) report PASS "$name" aspect "$msg" ;;
      3) report SKIP "$name" aspect "$msg" ;;
      *) report FAIL "$name" aspect "$msg" ;;
    esac
  else
    report FAIL "$name" aspect "ffprobe failed"
  fi

  # (6d) language tags per stream, in order; compared only where the source
  # tags a stream; SKIP when the source has no language tags at all.
  if probe "$dir/src.lang" -show_entries stream=index:stream_tags=language -of csv=p=0 "$file" &&
    probe "$dir/out.lang" -show_entries stream=index:stream_tags=language -of csv=p=0 "$out"; then
    msg="$(python3 "$tmp/helpers.py" lang "$dir/src.lang" "$dir/out.lang")"
    rc=$?
    case "$rc" in
      0) report PASS "$name" lang "$msg" ;;
      3) report SKIP "$name" lang "$msg" ;;
      *) report FAIL "$name" lang "$msg" ;;
    esac
  else
    report FAIL "$name" lang "ffprobe failed"
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

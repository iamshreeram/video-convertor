//! Track selection, timing and sample-entry construction (plan.rs).
//! Timing rules: DESIGN.md "Plan rules".

use crate::codec::{prepare_audio, prepare_video, AudioPrep, Prep, VideoPrep};
use crate::error::{Error, Result};
use crate::mkv::{Mkv, MkvTrack, SampleRef, TrackKind};
use crate::source::Source;

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// Always 1000.
    pub movie_timescale: u32,
    /// Movie units: max over tracks of the sum of edit segment durations.
    pub duration: u64,
    pub tracks: Vec<PlanTrack>,
    pub chunks: Vec<Chunk>,
    pub mdat_payload_size: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanTrack {
    /// 1-based; video first, then audio, in file order.
    pub track_id: u32,
    pub kind: TrackKind,
    /// "h264" | "hevc" | "av1" | "aac" | "mp3" | "opus" | "flac" | "ac3".
    pub codec_name: String,
    pub language: String,
    pub timescale: u32,
    /// Sum of sample durations, in track timescale units.
    pub media_duration: u64,
    /// tkhd display dimensions; 0 for audio.
    pub width: u32,
    pub height: u32,
    pub channels: u32,
    pub sample_rate: u32,
    /// Complete stsd child box, including its 8-byte header.
    pub sample_entry: Vec<u8>,
    pub samples: Vec<PlanSample>,
    pub edits: Vec<Edit>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanSample {
    pub offset: u64,
    pub size: u32,
    /// Track timescale; first sample = 0; strictly increasing.
    pub dts: u64,
    /// Duration in track timescale units, >= 1.
    pub duration: u32,
    pub cts_offset: u32,
    pub keyframe: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Edit {
    /// Movie timescale units.
    pub segment_duration: u64,
    /// Track timescale units; -1 = empty edit.
    pub media_time: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    /// Index into `Plan::tracks`.
    pub track: usize,
    pub first_sample: usize,
    pub sample_count: usize,
    /// Offset from the first byte of the mdat payload.
    pub rel_offset: u64,
}

const VIDEO_TIMESCALE: u32 = 90_000;
/// Video frame duration when nothing better is known (single sample, no default duration).
const FALLBACK_VIDEO_FRAME: i64 = 3_000;
const MAX_CHUNK_SAMPLES: usize = 512;
/// A chunk spans less than this many milliseconds of dts before its final sample.
const CHUNK_SPAN_MS: u128 = 500;
const OPUS_PAD_SKIP: &str = "Opus DiscardPadding not representable";

/// Video track chosen for output, with its prepared entry.
struct VideoSel<'a> {
    track: &'a MkvTrack,
    prep: VideoPrep,
    min_pts: i64,
}

/// Audio track chosen for output, with its normalised sample timing.
struct AudioSel<'a> {
    track: &'a MkvTrack,
    prep: AudioPrep,
    /// Sample indices in pts order (stable).
    order: Vec<usize>,
    /// Track units, relative to the first sample (strictly increasing).
    dts: Vec<i64>,
    durations: Vec<i64>,
    media_duration: u64,
    min_pts: i64,
}

/// Builds the output plan. `src` is read only for codec-specific probing
/// (first AC-3 frame, HEVC parameter-set checks, Opus TOC, FLAC last frame).
pub fn build_plan<S: Source>(mkv: &Mkv, src: &mut S) -> Result<Plan> {
    if mkv.tracks.is_empty() {
        return Err(Error::Unsupported("no tracks".into()));
    }
    let mut warnings = Vec::new();
    let mut notes: Vec<Option<String>> = with_capacity(mkv.tracks.len())?;
    let mut video: Option<VideoSel> = None;
    let mut audio: Vec<AudioSel> = Vec::new();
    for t in &mkv.tracks {
        let reason: Option<String> = match prelim_skip(t) {
            Some(r) => Some(r.to_string()),
            None => match t.kind {
                TrackKind::Video if video.is_some() => {
                    Some("only the first video track is converted".to_string())
                }
                TrackKind::Video => match prepare_video(t, src)? {
                    Prep::Ok(prep) => {
                        video = Some(VideoSel {
                            track: t,
                            prep,
                            min_pts: min_pts(t)?,
                        });
                        None
                    }
                    Prep::Skip(r) => Some(r),
                },
                TrackKind::Audio => match audio_timing(t, src)? {
                    Prep::Ok(sel) => {
                        audio.push(sel);
                        None
                    }
                    Prep::Skip(r) => Some(r),
                },
                TrackKind::Other => Some("unsupported track type".to_string()),
            },
        };
        if let Some(r) = &reason {
            warnings.push(format!(
                "track {} ({}) skipped: {}",
                t.number, t.codec_id, r
            ));
        }
        notes.push(reason);
    }
    if video.is_none() && audio.is_empty() {
        return Err(Error::Unsupported(unsupported_message(&mkv.tracks, &notes)));
    }

    // Global origin: earliest pts over the selected tracks.
    let t0 = video
        .iter()
        .map(|v| v.min_pts)
        .chain(audio.iter().map(|a| a.min_pts))
        .min()
        .ok_or_else(|| invalid("internal: no selected track"))?;

    let mut tracks = with_capacity::<PlanTrack>(usize::from(video.is_some()) + audio.len())?;
    if let Some(v) = video {
        let id = next_track_id(tracks.len())?;
        tracks.push(build_video(v, t0, id)?);
    }
    for a in audio {
        let id = next_track_id(tracks.len())?;
        tracks.push(build_audio(a, t0, id)?);
    }

    let (chunks, mdat_payload_size) = interleave(&tracks)?;
    let mut duration = 0u64;
    for t in &tracks {
        let mut sum = 0u64;
        for e in &t.edits {
            sum = add_u64(sum, e.segment_duration)?;
        }
        duration = duration.max(sum);
    }
    Ok(Plan {
        movie_timescale: 1000,
        duration,
        tracks,
        chunks,
        mdat_payload_size,
        warnings,
    })
}

/// Reasons that exclude a track before any codec preparation.
fn prelim_skip(t: &MkvTrack) -> Option<&'static str> {
    if t.kind == TrackKind::Other {
        Some("unsupported track type")
    } else if t.laced {
        Some("laced blocks are not supported")
    } else if t.content_encoded {
        Some("content encoding (compression/encryption) is not supported")
    } else if t.samples.is_empty() {
        Some("no samples")
    } else {
        None
    }
}

fn unsupported_message(tracks: &[MkvTrack], notes: &[Option<String>]) -> String {
    let mut parts = Vec::with_capacity(tracks.len());
    for (t, note) in tracks.iter().zip(notes) {
        let kind = match t.kind {
            TrackKind::Video => "video",
            TrackKind::Audio => "audio",
            TrackKind::Other => "other",
        };
        let reason = note.as_deref().unwrap_or(kind);
        parts.push(format!("{} ({})", t.codec_id, reason));
    }
    format!("no supported track: {}", parts.join(", "))
}

/// Prepares an audio track and computes its normalised timing. Returns a skip
/// reason when the track cannot be represented.
fn audio_timing<'a, S: Source>(t: &'a MkvTrack, src: &mut S) -> Result<Prep<AudioSel<'a>>> {
    let prep = match prepare_audio(t, src)? {
        Prep::Ok(p) => p,
        Prep::Skip(r) => return Ok(Prep::Skip(r)),
    };
    let n = t.samples.len();
    let ts = prep.timescale;

    // Matroska: CodecDelay MUST be subtracted from each Block timestamp (ffmpeg does this).
    let delay = match t.codec_delay_ns {
        Some(d) => i64::try_from(d).map_err(|_| too_large("codec delay exceeds 64 bits"))?,
        None => 0,
    };
    let mut eff = with_capacity::<i64>(n)?;
    for s in &t.samples {
        eff.push(checked(s.pts_ns.checked_sub(delay))?);
    }

    let mut order = with_capacity::<usize>(n)?;
    order.extend(0..n);
    order.sort_by_key(|&i| eff.get(i).copied().unwrap_or(i64::MAX));
    let first_idx = order
        .first()
        .copied()
        .ok_or_else(|| invalid("audio track has no samples"))?;
    let min_pts = eff
        .get(first_idx)
        .copied()
        .ok_or_else(|| invalid("internal: sample index out of range"))?;

    let mut units = with_capacity::<i64>(n)?;
    for &idx in &order {
        let e = eff
            .get(idx)
            .copied()
            .ok_or_else(|| invalid("internal: sample index out of range"))?;
        units.push(conv(i128::from(e) - i128::from(min_pts), ts)?);
    }

    // Single normalisation formula (DESIGN "AUDIO").
    let frame = prep.frame.map(i64::from);
    let mut dts = with_capacity::<i64>(n)?;
    dts.push(0);
    let mut prev = 0i64;
    for &a in units.iter().skip(1) {
        let bumped = checked(prev.checked_add(1))?;
        let next = match frame {
            Some(f) => {
                let expected = checked(prev.checked_add(f))?;
                let gap = (i128::from(a) - i128::from(expected)).abs();
                if gap < i128::from(f) {
                    expected
                } else {
                    a.max(bumped)
                }
            }
            None => a.max(bumped),
        };
        dts.push(next);
        prev = next;
    }

    let mut durations = with_capacity::<i64>(n)?;
    for w in dts.windows(2) {
        durations.push(checked(w[1].checked_sub(w[0]))?);
    }
    let last_idx = order
        .last()
        .copied()
        .ok_or_else(|| invalid("audio track has no samples"))?;
    let last = sample_by_index(t, last_idx)?;
    let last_units: Option<i128> = match (prep.last_duration, prep.frame, last.duration_ns) {
        (Some(d), _, _) => Some(i128::from(d)),
        (None, Some(f), _) => Some(i128::from(f)),
        (None, None, Some(ns)) => Some(i128::from(conv(i128::from(ns), ts)?)),
        (None, None, None) => None,
    };
    let prev_duration = durations.last().copied().map(i128::from);
    let last_duration = last_units.or(prev_duration).unwrap_or(1).max(1);
    durations
        .push(i64::try_from(last_duration).map_err(|_| too_large("duration exceeds 64 bits"))?);

    let mut media_duration = 0u64;
    for d in &durations {
        media_duration = add_u64(media_duration, to_u64(*d)?)?;
    }
    if prep.trim > 0 && prep.trim >= media_duration {
        return Ok(Prep::Skip(OPUS_PAD_SKIP.to_string()));
    }

    Ok(Prep::Ok(AudioSel {
        track: t,
        prep,
        order,
        dts,
        durations,
        media_duration,
        min_pts,
    }))
}

/// Video timing (DESIGN "VIDEO"): decode-order samples, presentation via cts_offset and one edit.
fn build_video(sel: VideoSel<'_>, t0: i64, track_id: u32) -> Result<PlanTrack> {
    let VideoSel { track: t, prep, .. } = sel;
    let ts = VIDEO_TIMESCALE;
    let n = t.samples.len();

    // q: decode order, units relative to the global origin.
    let mut q = with_capacity::<i64>(n)?;
    for s in &t.samples {
        q.push(conv(i128::from(s.pts_ns) - i128::from(t0), ts)?);
    }
    let mut sorted = with_capacity::<i64>(n)?;
    sorted.extend_from_slice(&q);
    sorted.sort_unstable();
    let s0 = sorted
        .first()
        .copied()
        .ok_or_else(|| invalid("video track has no samples"))?;

    // dts: sorted times relative to s0, then forced strictly increasing.
    let mut dts = with_capacity::<i64>(n)?;
    for &s in &sorted {
        let mut d = checked(s.checked_sub(s0))?;
        if let Some(&prev) = dts.last() {
            if d <= prev {
                d = checked(prev.checked_add(1))?;
            }
        }
        dts.push(d);
    }
    // r: intended presentation time relative to the earliest frame.
    let mut r = with_capacity::<i64>(n)?;
    for &qi in &q {
        r.push(checked(qi.checked_sub(s0))?);
    }
    // shift is computed from the FINAL dts.
    let mut shift = 0i64;
    for (ri, di) in r.iter().zip(&dts) {
        shift = shift.max(checked(di.checked_sub(*ri))?);
    }
    let mut cts = with_capacity::<u32>(n)?;
    for (ri, di) in r.iter().zip(&dts) {
        let c = checked(ri.checked_add(shift).and_then(|x| x.checked_sub(*di)))?;
        cts.push(to_u32(c)?);
    }

    // Frame duration: last presented sample's block duration, else default, else gap, else fallback.
    let last = t
        .samples
        .iter()
        .max_by_key(|s| s.pts_ns)
        .ok_or_else(|| invalid("video track has no samples"))?;
    let from_block = last
        .duration_ns
        .map(|d| conv(i128::from(d), ts))
        .transpose()?;
    let from_default = t
        .default_duration_ns
        .map(|d| conv(i128::from(d), ts))
        .transpose()?;
    let from_gap = match (sorted.last(), n.checked_sub(2).and_then(|k| sorted.get(k))) {
        (Some(a), Some(b)) if n >= 2 => Some(checked(a.checked_sub(*b))?),
        _ => None,
    };
    let frame = from_block
        .or(from_default)
        .or(from_gap)
        .unwrap_or(FALLBACK_VIDEO_FRAME)
        .max(1);

    let mut durs = with_capacity::<i64>(n)?;
    for w in dts.windows(2) {
        durs.push(checked(w[1].checked_sub(w[0]))?);
    }
    durs.push(frame);

    let mut samples = with_capacity::<PlanSample>(n)?;
    for (((s, d), du), c) in t.samples.iter().zip(&dts).zip(&durs).zip(&cts) {
        samples.push(PlanSample {
            offset: s.offset,
            size: s.size,
            dts: to_u64(*d)?,
            duration: to_u32(*du)?,
            cts_offset: *c,
            keyframe: s.keyframe,
        });
    }
    let mut media_duration = 0u64;
    for s in &samples {
        media_duration = add_u64(media_duration, u64::from(s.duration))?;
    }

    let max_r = r.iter().copied().max().unwrap_or(0);
    let presentation_len = to_u64(checked(max_r.checked_add(frame))?)?;
    let mut edits = Vec::with_capacity(2);
    if s0 > 0 {
        edits.push(Edit {
            segment_duration: movie(to_u64(s0)?, ts)?,
            media_time: -1,
        });
    }
    edits.push(Edit {
        segment_duration: movie(presentation_len, ts)?,
        media_time: shift,
    });

    let info = t
        .video
        .as_ref()
        .ok_or_else(|| invalid("video track has no video settings"))?;
    let (width, height) = match (info.display_width, info.display_height) {
        (Some(w), Some(h)) => (w, h),
        _ => (info.pixel_width, info.pixel_height),
    };
    let VideoPrep {
        codec_name, entry, ..
    } = prep;
    Ok(PlanTrack {
        track_id,
        kind: TrackKind::Video,
        codec_name: codec_name.to_string(),
        language: t.language.clone(),
        timescale: ts,
        media_duration,
        width,
        height,
        channels: 0,
        sample_rate: 0,
        sample_entry: entry,
        samples,
        edits,
    })
}

/// Audio plan track: edits relative to the global origin; samples in pts order.
fn build_audio(sel: AudioSel<'_>, t0: i64, track_id: u32) -> Result<PlanTrack> {
    let AudioSel {
        track: t,
        prep,
        order,
        dts,
        durations,
        media_duration,
        min_pts,
    } = sel;
    let ts = prep.timescale;

    let mut edits = Vec::with_capacity(2);
    let lead = conv(i128::from(min_pts) - i128::from(t0), ts)?;
    if lead > 0 {
        edits.push(Edit {
            segment_duration: movie(to_u64(lead)?, ts)?,
            media_time: -1,
        });
    }
    let playable = media_duration
        .checked_sub(prep.trim)
        .ok_or_else(|| invalid("audio trim exceeds media duration"))?;
    edits.push(Edit {
        segment_duration: movie(playable, ts)?,
        media_time: 0,
    });

    let mut samples = with_capacity::<PlanSample>(order.len())?;
    for ((&idx, d), du) in order.iter().zip(&dts).zip(&durations) {
        let s = sample_by_index(t, idx)?;
        samples.push(PlanSample {
            offset: s.offset,
            size: s.size,
            dts: to_u64(*d)?,
            duration: to_u32(*du)?,
            cts_offset: 0,
            keyframe: true,
        });
    }
    let AudioPrep {
        codec_name,
        entry,
        channels,
        sample_rate,
        ..
    } = prep;
    Ok(PlanTrack {
        track_id,
        kind: TrackKind::Audio,
        codec_name: codec_name.to_string(),
        language: t.language.clone(),
        timescale: ts,
        media_duration,
        width: 0,
        height: 0,
        channels,
        sample_rate,
        sample_entry: entry,
        samples,
        edits,
    })
}

/// Interleaves track samples into chunks in time order (DESIGN "INTERLEAVE").
/// Returns the chunk list and the total mdat payload size.
fn interleave(tracks: &[PlanTrack]) -> Result<(Vec<Chunk>, u64)> {
    let mut cursor = with_capacity::<usize>(tracks.len())?;
    cursor.resize(tracks.len(), 0);
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut rel = 0u64;
    loop {
        // Earliest next sample in seconds; ties keep the lower track index.
        let mut best: Option<(usize, u64, u32)> = None;
        for (k, t) in tracks.iter().enumerate() {
            let Some(s) = cursor.get(k).and_then(|&c| t.samples.get(c)) else {
                continue;
            };
            let earlier = match best {
                None => true,
                Some((_, bd, bts)) => {
                    u128::from(s.dts) * u128::from(bts) < u128::from(bd) * u128::from(t.timescale)
                }
            };
            if earlier {
                best = Some((k, s.dts, t.timescale));
            }
        }
        let Some((k, _, _)) = best else {
            break;
        };
        let track = tracks
            .get(k)
            .ok_or_else(|| invalid("internal: track index"))?;
        let first = cursor
            .get(k)
            .copied()
            .ok_or_else(|| invalid("internal: cursor index"))?;
        let count = chunk_len(&track.samples, first, track.timescale);
        if count == 0 {
            return Err(invalid("internal: empty chunk"));
        }
        let mut bytes = 0u64;
        for s in track.samples.iter().skip(first).take(count) {
            bytes = add_u64(bytes, u64::from(s.size))?;
        }
        chunks
            .try_reserve(1)
            .map_err(|_| too_large("chunk table allocation failed"))?;
        chunks.push(Chunk {
            track: k,
            first_sample: first,
            sample_count: count,
            rel_offset: rel,
        });
        rel = add_u64(rel, bytes)?;
        if let Some(c) = cursor.get_mut(k) {
            *c = first
                .checked_add(count)
                .ok_or_else(|| too_large("sample index overflow"))?;
        }
    }
    Ok((chunks, rel))
}

/// Number of samples a chunk starting at `first` takes: the first always joins; later samples
/// join while their dts is less than 500 ms after the chunk's first sample, up to 512 samples.
fn chunk_len(samples: &[PlanSample], first: usize, ts: u32) -> usize {
    let Some(head) = samples.get(first) else {
        return 0;
    };
    let mut count = 0usize;
    for s in samples.iter().skip(first).take(MAX_CHUNK_SAMPLES) {
        let span_ms_x1000 = u128::from(s.dts.saturating_sub(head.dts)) * 1000;
        let joins = count == 0 || span_ms_x1000 < CHUNK_SPAN_MS * u128::from(ts);
        if !joins {
            break;
        }
        count += 1;
    }
    count
}

// ---------------------------------------------------------------- helpers

/// Earliest pts of a track's samples.
fn min_pts(t: &MkvTrack) -> Result<i64> {
    t.samples
        .iter()
        .map(|s| s.pts_ns)
        .min()
        .ok_or_else(|| invalid("track has no samples"))
}

fn sample_by_index(t: &MkvTrack, idx: usize) -> Result<&SampleRef> {
    t.samples
        .get(idx)
        .ok_or_else(|| invalid("internal: sample index out of range"))
}

fn next_track_id(existing: usize) -> Result<u32> {
    u32::try_from(existing + 1).map_err(|_| too_large("too many tracks"))
}

fn invalid(msg: &str) -> Error {
    Error::InvalidMkv(msg.to_string())
}

fn too_large(msg: &str) -> Error {
    Error::TooLarge(msg.to_string())
}

fn checked(v: Option<i64>) -> Result<i64> {
    v.ok_or_else(|| too_large("timestamp arithmetic overflow"))
}

fn add_u64(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| too_large("duration overflow"))
}

fn to_u64(v: i64) -> Result<u64> {
    u64::try_from(v).map_err(|_| too_large("negative or oversized timestamp"))
}

fn to_u32(v: i64) -> Result<u32> {
    u32::try_from(v).map_err(|_| too_large("value exceeds 32 bits"))
}

/// Vector with exactly `n` capacity reserved fallibly.
fn with_capacity<T>(n: usize) -> Result<Vec<T>> {
    let mut v = Vec::new();
    v.try_reserve_exact(n)
        .map_err(|_| too_large("allocation failed"))?;
    Ok(v)
}

/// round_half_up(ns * ts / 1e9), exact in i128.
fn conv(ns: i128, ts: u32) -> Result<i64> {
    let scaled = ns * i128::from(ts) + 500_000_000;
    i64::try_from(scaled.div_euclid(1_000_000_000))
        .map_err(|_| too_large("timestamp exceeds 64 bits"))
}

/// round(units * 1000 / ts) (half up) in movie units; clamped to >= 1 when units > 0.
fn movie(units: u64, ts: u32) -> Result<u64> {
    if units == 0 {
        return Ok(0);
    }
    let ts = u128::from(ts.max(1));
    let doubled = u128::from(units) * 1000 * 2 + ts;
    let v = u64::try_from(doubled / (2 * ts)).map_err(|_| too_large("movie duration overflow"))?;
    Ok(v.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ptrack(ts: u32, dts: &[u64], size: u32) -> PlanTrack {
        PlanTrack {
            track_id: 1,
            kind: TrackKind::Audio,
            codec_name: "aac".into(),
            language: "und".into(),
            timescale: ts,
            media_duration: 0,
            width: 0,
            height: 0,
            channels: 0,
            sample_rate: 0,
            sample_entry: vec![],
            samples: dts
                .iter()
                .map(|&d| PlanSample {
                    offset: 0,
                    size,
                    dts: d,
                    duration: 1,
                    cts_offset: 0,
                    keyframe: true,
                })
                .collect(),
            edits: vec![],
        }
    }

    fn chunk_tuples(chunks: &[Chunk]) -> Vec<(usize, usize, usize, u64)> {
        chunks
            .iter()
            .map(|c| (c.track, c.first_sample, c.sample_count, c.rel_offset))
            .collect()
    }

    #[test]
    fn conv_rounds_half_up() {
        assert_eq!(conv(500_000_000, 1).unwrap(), 1);
        assert_eq!(conv(499_999_999, 1).unwrap(), 0);
        assert_eq!(conv(1_000_000_000, 90_000).unwrap(), 90_000);
        assert_eq!(conv(5_555, 90_000).unwrap(), 0);
        assert_eq!(conv(5_556, 90_000).unwrap(), 1);
    }

    #[test]
    fn movie_rounds_and_clamps_to_one() {
        assert_eq!(movie(0, 1000).unwrap(), 0);
        assert_eq!(movie(1, 1_000_000).unwrap(), 1);
        assert_eq!(movie(90_000, 90_000).unwrap(), 1000);
        assert_eq!(movie(3, 2000).unwrap(), 2);
    }

    #[test]
    fn interleave_orders_by_time_then_track_index() {
        // Tie at dts 0 goes to track 0; track 0 joins sample 1 (100 < 500 units) but not 600.
        let tracks = vec![
            ptrack(1000, &[0, 100, 600, 1200], 10),
            ptrack(1000, &[0, 50], 20),
        ];
        let (chunks, total) = interleave(&tracks).unwrap();
        assert_eq!(
            chunk_tuples(&chunks),
            vec![(0, 0, 2, 0), (1, 0, 2, 20), (0, 2, 1, 60), (0, 3, 1, 70)]
        );
        assert_eq!(total, 80);
    }

    #[test]
    fn chunk_span_is_strictly_below_500_ms_and_capped_at_512() {
        // ts = 1e6: 499_999 units = 499.999 ms joins; 500_000 units = 500 ms does not.
        let tracks = vec![ptrack(1_000_000, &[0, 499_999, 500_000], 1)];
        let (chunks, _) = interleave(&tracks).unwrap();
        assert_eq!(chunk_tuples(&chunks), vec![(0, 0, 2, 0), (0, 2, 1, 2)]);

        let dts: Vec<u64> = (0..600).collect();
        let tracks = vec![ptrack(1_000_000, &dts, 1)];
        let (chunks, _) = interleave(&tracks).unwrap();
        assert_eq!(
            chunks.iter().map(|c| c.sample_count).collect::<Vec<_>>(),
            vec![512, 88]
        );
    }
}

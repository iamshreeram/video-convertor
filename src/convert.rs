//! Top-level conversion pipeline: scan -> plan -> header check -> write.

use crate::error::{Error, Result};
use crate::mkv::{scan, AudioInfo, Mkv, SampleRef, TrackKind, READ_MAX_WINDOW, READ_MIN_WINDOW};
use crate::mp4::{build_header, write_mp4};
use crate::plan::{build_plan, Plan};
use crate::source::{BufferedSource, ConcatSource, EmptySource, Sink, Source};

/// Read-ahead window wrapped around the input source.
const READ_WINDOW_BYTES: usize = 4 << 20;
/// Share of the progress range taken by the scan phase; the write phase takes the rest.
const SCAN_SHARE: f64 = 0.3;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConvertOptions {
    /// `None` = unlimited. If the exact output size exceeds this, fails with TooLarge before writing.
    pub max_output_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConvertReport {
    pub warnings: Vec<String>,
    /// Plan codec name of the video track, e.g. "hevc".
    pub video_codec: Option<String>,
    pub audio_codecs: Vec<String>,
    pub duration_ms: u64,
    pub sample_count: u64,
    /// Bytes written; equals the sink byte count.
    pub output_size: u64,
}

/// Converts `src` (MKV) to MP4 written into `sink`. `progress` is monotone in [0,1], ends at 1.0 on success.
pub fn convert<S: Source, K: Sink>(
    src: S,
    sink: &mut K,
    opts: &ConvertOptions,
    progress: &mut dyn FnMut(f64),
) -> Result<ConvertReport> {
    convert_with_replacements(src, EmptySource, &[], sink, opts, progress)
}

/// Like [`convert`], but audio tracks listed in `replacements` use the packets stored in `extra`
/// (for example Vorbis re-encoded to AAC by the browser) instead of the packets in the file.
pub fn convert_with_replacements<S: Source, E: Source, K: Sink>(
    src: S,
    extra: E,
    replacements: &[TrackReplacement],
    sink: &mut K,
    opts: &ConvertOptions,
    progress: &mut dyn FnMut(f64),
) -> Result<ConvertReport> {
    let mut combined = ConcatSource::new(src, extra);
    let mut reporter = Progress {
        last: f64::NEG_INFINITY,
        inner: progress,
    };
    reporter.report(0.0);

    let analysis = analyze(&mut combined, replacements, &mut |pos, len| {
        reporter.report(scan_fraction(pos, len))
    })?;
    write_and_report(
        analysis,
        &mut combined,
        sink,
        opts,
        &mut reporter,
        SCAN_SHARE,
    )
}

/// Size check, then the write phase. `base` is the progress already used by earlier phases.
fn write_and_report<A: Source, B: Source, K: Sink>(
    analysis: Analysis,
    combined: &mut ConcatSource<A, B>,
    sink: &mut K,
    opts: &ConvertOptions,
    reporter: &mut Progress<'_>,
    base: f64,
) -> Result<ConvertReport> {
    let Analysis {
        mkv,
        plan,
        total_size,
        ..
    } = analysis;

    // Exact size check before anything reaches the sink. (The header is rebuilt inside
    // write_mp4; only its size is kept, so the two copies never coexist.)
    if let Some(limit) = opts.max_output_bytes {
        if total_size > limit {
            return Err(Error::TooLarge(format!(
                "output would be {total_size} bytes, limit is {limit}"
            )));
        }
    }

    // Write phase: slice reads are at most 1 MiB; the 4 MiB window absorbs the A/V interleave.
    let mut write_src = BufferedSource::new(&mut *combined, READ_WINDOW_BYTES);
    let output_size = write_mp4(&plan, &mut write_src, sink, &mut |done, total| {
        reporter.report(write_fraction(done, total, base));
    })?;
    reporter.report(1.0);

    build_report(mkv, &plan, output_size)
}

/// One encoded packet of a replacement track; its bytes are stored back to back in `extra`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplacementSample {
    pub size: u32,
    pub pts_ns: i64,
    pub duration_ns: u64,
}

/// An audio track whose packets were re-encoded outside the engine (all samples are key frames).
#[derive(Debug, Clone, PartialEq)]
pub struct TrackReplacement {
    /// Matroska track number being replaced.
    pub track_number: u64,
    /// New Matroska codec id, e.g. "A_AAC" or "A_OPUS".
    pub codec_id: String,
    /// AudioSpecificConfig (AAC) or OpusHead (Opus).
    pub codec_private: Vec<u8>,
    pub sample_rate: f64,
    pub channels: u32,
    pub codec_delay_ns: Option<u64>,
    pub samples: Vec<ReplacementSample>,
}

/// An audio track the engine cannot copy but the browser may be able to re-encode.
#[derive(Debug, Clone, PartialEq)]
pub struct ReencodableTrack {
    pub number: u64,
    pub codec_id: String,
    pub channels: u32,
    pub sample_rate: u32,
}

/// Codec details of an exported track.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackExport {
    pub codec_id: String,
    pub codec_private: Vec<u8>,
    pub sample_rate: f64,
    pub channels: u32,
}

/// Streams every packet of `track_number` (file order) to `sink(pts_ns, bytes)`, reading the file
/// with large sequential windows. Used to hand Vorbis packets to the browser's decoder.
pub fn export_track_packets<S: Source>(
    mut src: S,
    track_number: u64,
    sink: &mut dyn FnMut(i64, &[u8]) -> Result<()>,
) -> Result<TrackExport> {
    let mkv = scan(&mut src, &mut |_, _| {})?;
    export_from_mkv(&mkv, src, track_number, sink)
}

fn export_from_mkv<S: Source>(
    mkv: &Mkv,
    mut src: S,
    track_number: u64,
    sink: &mut dyn FnMut(i64, &[u8]) -> Result<()>,
) -> Result<TrackExport> {
    let track = mkv
        .tracks
        .iter()
        .find(|t| t.number == track_number)
        .ok_or_else(|| Error::Unsupported(format!("no track {track_number}")))?;
    if track.laced || track.content_encoded {
        return Err(Error::Unsupported(
            "track uses lacing or content encoding".into(),
        ));
    }
    let audio = track
        .audio
        .as_ref()
        .ok_or_else(|| Error::Unsupported(format!("track {track_number} is not audio")))?;
    let export = TrackExport {
        codec_id: track.codec_id.clone(),
        codec_private: track.codec_private.clone(),
        sample_rate: audio
            .output_sampling_frequency
            .unwrap_or(audio.sampling_frequency),
        channels: audio.channels,
    };
    let mut window = BufferedSource::new_adaptive(&mut src, READ_MIN_WINDOW, READ_MAX_WINDOW);
    let mut buf: Vec<u8> = Vec::new();
    for sample in &track.samples {
        let n = sample.size as usize;
        buf.clear();
        buf.try_reserve(n)
            .map_err(|_| Error::TooLarge("packet allocation failed".into()))?;
        buf.resize(n, 0);
        window.read_at(sample.offset, &mut buf)?;
        sink(sample.pts_ns, &buf)?;
    }
    Ok(export)
}

/// Swaps the packets of the listed audio tracks for the replacement packets, which are addressed
/// in the combined source right after the original file (`file_len`).
fn apply_replacements(
    mkv: &mut Mkv,
    file_len: u64,
    extra_len: u64,
    replacements: &[TrackReplacement],
) -> Result<()> {
    let mut done: Vec<u64> = Vec::new();
    let mut cursor = 0u64;
    for r in replacements {
        if done.contains(&r.track_number) {
            return Err(Error::Unsupported(format!(
                "track {} replaced twice",
                r.track_number
            )));
        }
        done.push(r.track_number);
        if r.samples.is_empty() {
            return Err(Error::Unsupported("replacement has no samples".into()));
        }
        if !r.sample_rate.is_finite() || r.sample_rate <= 0.0 || r.channels == 0 {
            return Err(Error::Unsupported(
                "replacement audio format is invalid".into(),
            ));
        }
        let track = mkv
            .tracks
            .iter_mut()
            .find(|t| t.number == r.track_number)
            .ok_or_else(|| Error::Unsupported(format!("no track {}", r.track_number)))?;
        if track.kind != TrackKind::Audio {
            return Err(Error::Unsupported(format!(
                "track {} is not audio",
                r.track_number
            )));
        }
        let mut samples = Vec::new();
        samples
            .try_reserve_exact(r.samples.len())
            .map_err(|_| Error::TooLarge("replacement sample table".into()))?;
        for s in &r.samples {
            if s.size == 0 {
                return Err(Error::Unsupported("replacement has an empty packet".into()));
            }
            samples.push(SampleRef {
                offset: file_len + cursor,
                size: s.size,
                pts_ns: s.pts_ns,
                keyframe: true,
                duration_ns: Some(s.duration_ns),
                discard_padding_ns: None,
            });
            cursor = cursor
                .checked_add(u64::from(s.size))
                .ok_or_else(|| Error::TooLarge("replacement data size overflow".into()))?;
            if cursor > extra_len {
                return Err(Error::Io(
                    "replacement data is shorter than its sample table".into(),
                ));
            }
        }
        track.codec_id = r.codec_id.clone();
        track.codec_private = r.codec_private.clone();
        track.audio = Some(AudioInfo {
            sampling_frequency: r.sample_rate,
            output_sampling_frequency: None,
            channels: r.channels,
            bit_depth: None,
        });
        track.codec_delay_ns = r.codec_delay_ns;
        track.seek_pre_roll_ns = None;
        track.default_duration_ns = None;
        track.laced = false;
        track.content_encoded = false;
        track.samples = samples;
    }
    Ok(())
}

/// Audio tracks of kind Vorbis that a browser decoder + encoder could turn into AAC/Opus.
fn reencodable_tracks(mkv: &Mkv) -> Vec<ReencodableTrack> {
    mkv.tracks
        .iter()
        .filter(|t| {
            t.kind == TrackKind::Audio
                && t.codec_id == "A_VORBIS"
                && !t.laced
                && !t.content_encoded
                && !t.samples.is_empty()
        })
        .filter_map(|t| {
            let a = t.audio.as_ref()?;
            let rate = a.output_sampling_frequency.unwrap_or(a.sampling_frequency);
            Some(ReencodableTrack {
                number: t.number,
                codec_id: t.codec_id.clone(),
                channels: a.channels,
                sample_rate: if rate.is_finite() && rate > 0.0 && rate < 4e9 {
                    rate.round() as u32
                } else {
                    0
                },
            })
        })
        .collect()
}

/// Result of the scan and plan phases; nothing has been written yet.
struct Analysis {
    mkv: Mkv,
    plan: Plan,
    /// Exact size of the MP4 that `write_mp4` will produce.
    total_size: u64,
    /// Tracks still skipped because they need re-encoding.
    reencodable: Vec<ReencodableTrack>,
}

/// Scan and plan phases, shared by `convert` and `probe` so the two cannot drift.
/// Reads only; writes nothing. The scan sees only the original file; the plan sees the file
/// followed by the replacement packets.
fn analyze<A: Source, B: Source>(
    src: &mut ConcatSource<A, B>,
    replacements: &[TrackReplacement],
    scan_progress: &mut dyn FnMut(u64, u64),
) -> Result<Analysis> {
    // scan wraps the source in its own adaptive window; no extra layer here.
    let mkv = scan(src.primary_mut(), scan_progress)?;
    let file_len = src.primary_len();
    analyze_scanned(mkv, file_len, src, replacements)
}

/// The plan phase on an already scanned file (so the scan pass is not repeated).
fn analyze_scanned<A: Source, B: Source>(
    mut mkv: Mkv,
    file_len: u64,
    src: &mut ConcatSource<A, B>,
    replacements: &[TrackReplacement],
) -> Result<Analysis> {
    let extra_len = src.len() - file_len;
    apply_replacements(&mut mkv, file_len, extra_len, replacements)?;
    let reencodable = reencodable_tracks(&mkv);
    // Plan phase: only tiny header reads, so a small adaptive window suffices.
    let plan = {
        let mut plan_src =
            BufferedSource::new_adaptive(&mut *src, READ_MIN_WINDOW, READ_MAX_WINDOW);
        build_plan(&mkv, &mut plan_src)?
    };
    let total_size = build_header(&plan)?.total_size;
    Ok(Analysis {
        mkv,
        plan,
        total_size,
        reencodable,
    })
}

/// One selected output track, as reported by `probe`.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackReport {
    pub kind: TrackKind,
    /// Plan codec name, e.g. "h264", "aac".
    pub codec: String,
    /// Display dimensions; 0 for audio.
    pub width: u32,
    pub height: u32,
    /// 0 for video.
    pub channels: u32,
    /// 0 for video.
    pub sample_rate: u32,
    pub language: String,
    pub sample_count: u64,
}

/// Describes what `convert` would produce for an input, without producing it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeReport {
    /// Selected tracks in output order (video first).
    pub tracks: Vec<TrackReport>,
    pub duration_ms: u64,
    /// Exact bytes `convert` would write.
    pub output_size: u64,
    /// Scan warnings followed by plan warnings, as in `ConvertReport`.
    pub warnings: Vec<String>,
    /// Skipped audio tracks that could be re-encoded by the caller (see `TrackReplacement`).
    pub reencodable: Vec<ReencodableTrack>,
}

/// Scans and plans `src` exactly as `convert` does, but writes nothing.
/// Fails with the same errors `convert` would fail with for the same input.
pub fn probe<S: Source>(src: S) -> Result<ProbeReport> {
    probe_with_replacements(src, EmptySource, &[])
}

/// [`probe`] with replacement audio packets (see [`convert_with_replacements`]).
pub fn probe_with_replacements<S: Source, E: Source>(
    src: S,
    extra: E,
    replacements: &[TrackReplacement],
) -> Result<ProbeReport> {
    let mut combined = ConcatSource::new(src, extra);
    let analysis = analyze(&mut combined, replacements, &mut |_, _| {})?;
    Ok(probe_report(analysis))
}

fn probe_report(analysis: Analysis) -> ProbeReport {
    let Analysis {
        mkv,
        plan,
        total_size,
        reencodable,
    } = analysis;
    let tracks = plan
        .tracks
        .iter()
        .map(|t| TrackReport {
            kind: t.kind,
            codec: t.codec_name.clone(),
            width: t.width,
            height: t.height,
            channels: t.channels,
            sample_rate: t.sample_rate,
            language: t.language.clone(),
            sample_count: t.samples.len() as u64,
        })
        .collect();
    let mut warnings = mkv.warnings;
    warnings.extend(plan.warnings.iter().cloned());
    ProbeReport {
        tracks,
        duration_ms: plan.duration,
        output_size: total_size,
        warnings,
        reencodable,
    }
}

/// The result of the scan pass, kept so that probing, exporting audio packets and converting do
/// not each read the whole file again (a full scan reads every byte of the input).
pub struct Scanned {
    mkv: Mkv,
    file_len: u64,
}

/// Runs the scan pass on `src`. `progress(position, length)` reports bytes scanned.
pub fn scan_source<S: Source>(mut src: S, progress: &mut dyn FnMut(u64, u64)) -> Result<Scanned> {
    let file_len = src.len();
    let mkv = scan(&mut src, progress)?;
    Ok(Scanned { mkv, file_len })
}

impl Scanned {
    /// Same as [`probe_with_replacements`], without scanning again. `src` must be the file that
    /// was scanned.
    pub fn probe<S: Source, E: Source>(
        &self,
        src: S,
        extra: E,
        replacements: &[TrackReplacement],
    ) -> Result<ProbeReport> {
        let mut combined = ConcatSource::new(src, extra);
        let analysis =
            analyze_scanned(self.mkv.clone(), self.file_len, &mut combined, replacements)?;
        Ok(probe_report(analysis))
    }

    /// Same as [`export_track_packets`], without scanning again.
    pub fn export_track_packets<S: Source>(
        &self,
        src: S,
        track_number: u64,
        sink: &mut dyn FnMut(i64, &[u8]) -> Result<()>,
    ) -> Result<TrackExport> {
        export_from_mkv(&self.mkv, src, track_number, sink)
    }

    /// Same as [`convert_with_replacements`], without scanning again. `progress` covers only the
    /// planning and writing phases (0..=1), because scanning already happened.
    pub fn convert<S: Source, E: Source, K: Sink>(
        self,
        src: S,
        extra: E,
        replacements: &[TrackReplacement],
        sink: &mut K,
        opts: &ConvertOptions,
        progress: &mut dyn FnMut(f64),
    ) -> Result<ConvertReport> {
        let mut combined = ConcatSource::new(src, extra);
        let mut reporter = Progress {
            last: f64::NEG_INFINITY,
            inner: progress,
        };
        reporter.report(0.0);
        let analysis = analyze_scanned(self.mkv, self.file_len, &mut combined, replacements)?;
        write_and_report(analysis, &mut combined, sink, opts, &mut reporter, 0.0)
    }
}

/// Forwards progress to the caller. Values are clamped to [0, 1] and any value that is not
/// above the last one sent is dropped, so the reported sequence never goes backwards.
struct Progress<'a> {
    last: f64,
    inner: &'a mut dyn FnMut(f64),
}

impl Progress<'_> {
    fn report(&mut self, value: f64) {
        if value.is_nan() {
            return;
        }
        let clamped = value.clamp(0.0, 1.0);
        if clamped > self.last {
            self.last = clamped;
            (self.inner)(clamped);
        }
    }
}

fn scan_fraction(pos: u64, len: u64) -> f64 {
    if len == 0 {
        SCAN_SHARE
    } else {
        SCAN_SHARE * (pos as f64 / len as f64)
    }
}

fn write_fraction(done: u64, total: u64, base: f64) -> f64 {
    if total == 0 {
        base
    } else {
        base + (1.0 - base) * (done as f64 / total as f64)
    }
}

fn build_report(mkv: Mkv, plan: &Plan, output_size: u64) -> Result<ConvertReport> {
    let video_codec = plan
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .map(|t| t.codec_name.clone());
    let audio_codecs = plan
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Audio)
        .map(|t| t.codec_name.clone())
        .collect();
    let sample_count = plan.tracks.iter().try_fold(0u64, |acc, t| {
        acc.checked_add(t.samples.len() as u64)
            .ok_or_else(|| Error::TooLarge("sample count overflow".into()))
    })?;
    let mut warnings = mkv.warnings;
    warnings.extend(plan.warnings.iter().cloned());
    Ok(ConvertReport {
        warnings,
        video_codec,
        audio_codecs,
        duration_ms: plan.duration,
        sample_count,
        output_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_starts_at_zero_is_clamped_and_never_goes_back() {
        let mut seen: Vec<f64> = Vec::new();
        let mut sink = |v: f64| seen.push(v);
        let mut reporter = Progress {
            last: f64::NEG_INFINITY,
            inner: &mut sink,
        };
        reporter.report(0.0);
        reporter.report(0.5);
        reporter.report(0.2);
        reporter.report(f64::NAN);
        reporter.report(1.7);
        reporter.report(1.0);
        drop(reporter);
        assert_eq!(seen, vec![0.0, 0.5, 1.0]);
    }

    #[test]
    fn phase_fractions_map_into_their_ranges() {
        assert_eq!(scan_fraction(0, 0), SCAN_SHARE);
        assert_eq!(scan_fraction(5, 10), 0.15);
        assert_eq!(write_fraction(0, 0, SCAN_SHARE), SCAN_SHARE);
        assert!(write_fraction(10, 10, SCAN_SHARE) >= 0.999_999);
        assert_eq!(write_fraction(0, 10, SCAN_SHARE), SCAN_SHARE);
    }
}

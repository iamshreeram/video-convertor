//! Top-level conversion pipeline: scan -> plan -> header check -> write.

use crate::error::{Error, Result};
use crate::mkv::{scan, Mkv, TrackKind};
use crate::mp4::{build_header, write_mp4};
use crate::plan::{build_plan, Plan};
use crate::source::{BufferedSource, Sink, Source};

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
    mut src: S,
    sink: &mut K,
    opts: &ConvertOptions,
    progress: &mut dyn FnMut(f64),
) -> Result<ConvertReport> {
    let mut reporter = Progress {
        last: f64::NEG_INFINITY,
        inner: progress,
    };
    reporter.report(0.0);

    let Analysis {
        mkv,
        plan,
        total_size,
    } = analyze(&mut src, &mut |pos, len| {
        reporter.report(scan_fraction(pos, len))
    })?;

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
    let mut write_src = BufferedSource::new(&mut src, READ_WINDOW_BYTES);
    let output_size = write_mp4(&plan, &mut write_src, sink, &mut |done, total| {
        reporter.report(write_fraction(done, total))
    })?;
    reporter.report(1.0);

    build_report(mkv, &plan, output_size)
}

/// Result of the scan and plan phases; nothing has been written yet.
struct Analysis {
    mkv: Mkv,
    plan: Plan,
    /// Exact size of the MP4 that `write_mp4` will produce.
    total_size: u64,
}

/// Scan and plan phases, shared by `convert` and `probe` so the two cannot drift.
/// Reads only; writes nothing.
fn analyze<S: Source>(src: &mut S, scan_progress: &mut dyn FnMut(u64, u64)) -> Result<Analysis> {
    // scan wraps the source in its own adaptive window; no extra layer here.
    let mkv = scan(&mut *src, scan_progress)?;
    // Plan phase: only tiny header reads, so a small adaptive window suffices.
    let plan = {
        let mut plan_src = BufferedSource::new_adaptive(&mut *src, 4096, 1 << 20);
        build_plan(&mkv, &mut plan_src)?
    };
    let total_size = build_header(&plan)?.total_size;
    Ok(Analysis {
        mkv,
        plan,
        total_size,
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
}

/// Scans and plans `src` exactly as `convert` does, but writes nothing.
/// Fails with the same errors `convert` would fail with for the same input.
pub fn probe<S: Source>(mut src: S) -> Result<ProbeReport> {
    let Analysis {
        mkv,
        plan,
        total_size,
    } = analyze(&mut src, &mut |_, _| {})?;
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
    Ok(ProbeReport {
        tracks,
        duration_ms: plan.duration,
        output_size: total_size,
        warnings,
    })
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

fn write_fraction(done: u64, total: u64) -> f64 {
    if total == 0 {
        SCAN_SHARE
    } else {
        SCAN_SHARE + (1.0 - SCAN_SHARE) * (done as f64 / total as f64)
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
        assert_eq!(write_fraction(0, 0), SCAN_SHARE);
        assert!(write_fraction(10, 10) >= 0.999_999);
        assert_eq!(write_fraction(0, 10), SCAN_SHARE);
    }
}

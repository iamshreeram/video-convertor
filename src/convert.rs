//! Top-level conversion pipeline: scan -> plan -> header check -> write.

use crate::error::Result;
use crate::source::{Sink, Source};

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
    _src: S,
    _sink: &mut K,
    _opts: &ConvertOptions,
    _progress: &mut dyn FnMut(f64),
) -> Result<ConvertReport> {
    todo!("S5")
}

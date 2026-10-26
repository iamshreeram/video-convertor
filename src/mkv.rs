//! Pass 1: walks Matroska/WebM EBML structure and records per-track sample references.
//! Payloads are never read here; see DESIGN.md "MKV scan rules".

use crate::error::Result;
use crate::source::Source;

#[derive(Debug, Clone, PartialEq)]
pub struct Mkv {
    pub timecode_scale_ns: u64,
    pub duration_ns: Option<u64>,
    pub tracks: Vec<MkvTrack>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Video,
    Audio,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MkvTrack {
    pub number: u64,
    pub kind: TrackKind,
    pub codec_id: String,
    pub codec_private: Vec<u8>,
    /// "und" if absent.
    pub language: String,
    pub default_duration_ns: Option<u64>,
    pub codec_delay_ns: Option<u64>,
    pub seek_pre_roll_ns: Option<u64>,
    pub video: Option<VideoInfo>,
    pub audio: Option<AudioInfo>,
    pub laced: bool,
    pub content_encoded: bool,
    /// File order = decode order.
    pub samples: Vec<SampleRef>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoInfo {
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub display_width: Option<u32>,
    pub display_height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioInfo {
    pub sampling_frequency: f64,
    pub output_sampling_frequency: Option<f64>,
    pub channels: u32,
    pub bit_depth: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SampleRef {
    pub offset: u64,
    pub size: u32,
    pub pts_ns: i64,
    pub keyframe: bool,
    pub duration_ns: Option<u64>,
    pub discard_padding_ns: Option<i64>,
}

/// Resource limits for the scan pass.
#[derive(Debug, Clone, PartialEq)]
pub struct Limits {
    pub max_samples: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_samples: 20_000_000,
        }
    }
}

/// Scans with default [`Limits`].
pub fn scan<S: Source>(src: &mut S, progress: &mut dyn FnMut(u64, u64)) -> Result<Mkv> {
    scan_with_limits(src, progress, &Limits::default())
}

/// Scans with explicit limits. Exceeding `max_samples` -> `Error::TooLarge`.
pub fn scan_with_limits<S: Source>(
    _src: &mut S,
    _progress: &mut dyn FnMut(u64, u64),
    _limits: &Limits,
) -> Result<Mkv> {
    todo!("S2")
}

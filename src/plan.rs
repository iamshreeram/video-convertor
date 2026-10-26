//! Track selection, timing and sample-entry construction (plan.rs).
//! Timing rules: DESIGN.md "Plan rules".

use crate::error::Result;
use crate::mkv::{Mkv, TrackKind};
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

/// Builds the output plan. `src` is read only for codec-specific probing
/// (first AC-3 frame, HEVC parameter-set checks, Opus TOC, FLAC last frame).
pub fn build_plan<S: Source>(_mkv: &Mkv, _src: &mut S) -> Result<Plan> {
    todo!("S3")
}

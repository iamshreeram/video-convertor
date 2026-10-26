//! Per-codec preparation: sample entries (stsd children) and codec-specific probing.
//! Internal contract: DESIGN.md "codec.rs internal contract".

use crate::error::Result;
use crate::mkv::MkvTrack;
use crate::source::Source;

#[allow(dead_code)]
pub(crate) enum Prep<T> {
    Ok(T),
    /// Reason becomes the warning "track N (<codec_id>) skipped: <reason>".
    Skip(String),
}

#[allow(dead_code)]
pub(crate) struct VideoPrep {
    /// "h264" | "hevc" | "av1".
    pub codec_name: &'static str,
    pub entry_type: [u8; 4],
    pub entry: Vec<u8>,
}

#[allow(dead_code)]
pub(crate) struct AudioPrep {
    pub codec_name: &'static str,
    pub entry: Vec<u8>,
    pub timescale: u32,
    pub channels: u32,
    pub sample_rate: u32,
    /// Fixed samples per frame in timescale units.
    pub frame: Option<u32>,
    /// Units; Opus TOC / FLAC last frame header.
    pub last_duration: Option<u64>,
    /// Units; positive Opus DiscardPadding on the last block, else 0.
    pub trim: u64,
}

#[allow(dead_code)]
pub(crate) fn prepare_video<S: Source>(_t: &MkvTrack, _src: &mut S) -> Result<Prep<VideoPrep>> {
    todo!("S3")
}

#[allow(dead_code)]
pub(crate) fn prepare_audio<S: Source>(_t: &MkvTrack, _src: &mut S) -> Result<Prep<AudioPrep>> {
    todo!("S3")
}

/// MPEG-4 descriptor length: always 4 bytes. n >= 2^28 -> `Error::TooLarge`.
#[allow(dead_code)]
pub(crate) fn desc_len(_n: usize) -> Result<[u8; 4]> {
    todo!("S4")
}

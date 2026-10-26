//! mkv2mp4: a streaming MKV -> MP4 remuxer (no re-encoding).
#![forbid(unsafe_code)]

mod codec;
pub mod convert;
mod ebml;
pub mod error;
pub mod mkv;
pub mod mp4;
pub mod plan;
pub mod source;

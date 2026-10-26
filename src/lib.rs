//! mkv2mp4: a streaming MKV -> MP4 remuxer (no re-encoding).
#![cfg_attr(not(target_arch = "wasm32"), forbid(unsafe_code))]

mod codec;
pub mod convert;
mod ebml;
pub mod error;
#[cfg(any(test, target_arch = "wasm32"))]
pub(crate) mod json;
pub mod mkv;
pub mod mp4;
pub mod plan;
pub mod source;
#[cfg(target_arch = "wasm32")]
mod wasm;

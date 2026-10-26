//! MP4 box writer: moov construction (build_moov / build_header) and streamed mdat output.
//! Big-endian; rules in DESIGN.md "MP4 writer rules".

use crate::error::Result;
use crate::plan::Plan;
use crate::source::{Sink, Source};

#[derive(Debug, Clone)]
pub struct Header {
    /// ftyp + moov + mdat box header.
    pub bytes: Vec<u8>,
    /// true -> co64 chunk offsets; false -> stco.
    pub co64: bool,
    /// bytes.len() + mdat_payload_size.
    pub total_size: u64,
}

/// Builds the complete moov box. Length depends only on `plan` and `co64`.
/// `co64 == false` with an offset > u32::MAX -> `Error::TooLarge`.
pub fn build_moov(_plan: &Plan, _mdat_payload_offset: u64, _co64: bool) -> Result<Vec<u8>> {
    todo!("S4")
}

/// Computes ftyp + moov + mdat header and the co64 decision.
pub fn build_header(_plan: &Plan) -> Result<Header> {
    todo!("S4")
}

/// Writes header then all sample payloads in chunk order. Returns total bytes written.
pub fn write_mp4<S: Source, K: Sink>(
    _plan: &Plan,
    _src: &mut S,
    _sink: &mut K,
    _progress: &mut dyn FnMut(u64, u64),
) -> Result<u64> {
    todo!("S4")
}

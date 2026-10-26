//! MP4 box writer: moov construction (build_moov / build_header) and streamed mdat output.
//! Big-endian; rules in DESIGN.md "MP4 writer rules".

use crate::error::{Error, Result};
use crate::mkv::TrackKind;
use crate::plan::{Chunk, Plan, PlanTrack};
use crate::source::{Sink, Source};

/// Largest single source read; also the size of the reusable read buffer.
const SLICE_BYTES: usize = 1 << 20;
/// The staging buffer is flushed to the sink once it holds at least this many bytes.
const FLUSH_BYTES: usize = 1 << 20;
/// Identity transformation matrix shared by mvhd and tkhd.
const IDENTITY_MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
/// Full-box version word for version 1 (version byte 1, flags 0).
const VERSION_1: u32 = 1 << 24;

#[derive(Debug, Clone)]
pub struct Header {
    /// ftyp + moov + mdat box header.
    pub bytes: Vec<u8>,
    /// true -> co64 chunk offsets; false -> stco.
    pub co64: bool,
    /// bytes.len() + mdat_payload_size.
    pub total_size: u64,
}

/// How chunk offsets are written into stco / co64.
#[derive(Clone, Copy)]
struct Offsets {
    /// Absolute file offset of the first mdat payload byte.
    payload_offset: u64,
    /// Write co64 (64-bit) entries instead of stco.
    co64: bool,
    /// Reject stco offsets above u32::MAX. Only the sizing pass in `build_header` turns this
    /// off: stco entries are fixed width, so the box length does not depend on their values.
    check_stco: bool,
}

/// Builds the complete moov box. Length depends only on `plan` and `co64`.
/// `co64 == false` with an offset > u32::MAX -> `Error::TooLarge`.
pub fn build_moov(plan: &Plan, mdat_payload_offset: u64, co64: bool) -> Result<Vec<u8>> {
    let offsets = Offsets {
        payload_offset: mdat_payload_offset,
        co64,
        check_stco: true,
    };
    build_moov_with(plan, offsets)
}

/// Computes ftyp + moov + mdat header and the co64 decision.
pub fn build_header(plan: &Plan) -> Result<Header> {
    let ftyp = build_ftyp(plan)?;
    let ftyp_len = ftyp.len() as u64;
    let payload = plan.mdat_payload_size;

    // Sizing pass with stco: the length is offset-independent, so range checks are skipped.
    let sizing = Offsets {
        payload_offset: 0,
        co64: false,
        check_stco: false,
    };
    let moov_stco_len = build_moov_with(plan, sizing)?.len() as u64;

    // Conservative end-of-file bound: stco only if every possible chunk offset fits.
    let bound = u128::from(ftyp_len) + u128::from(moov_stco_len) + 16 + u128::from(payload);
    let co64 = bound > u128::from(u32::MAX);
    let moov_len = if co64 {
        build_moov(plan, 0, true)?.len() as u64
    } else {
        moov_stco_len
    };

    let mdat_hdr_len: u64 = if 8u128 + u128::from(payload) > u128::from(u32::MAX) {
        16
    } else {
        8
    };
    let payload_offset = ftyp_len
        .checked_add(moov_len)
        .and_then(|v| v.checked_add(mdat_hdr_len))
        .ok_or_else(|| too_large("header size overflow"))?;

    let moov = build_moov(plan, payload_offset, co64)?;
    if moov.len() as u64 != moov_len {
        return Err(internal("moov size changed"));
    }

    let mut bytes = ftyp;
    let reserve = moov
        .len()
        .checked_add(mdat_hdr_len as usize)
        .ok_or_else(alloc_failed)?;
    bytes.try_reserve(reserve).map_err(|_| alloc_failed())?;
    bytes.extend_from_slice(&moov);
    drop(moov);

    if mdat_hdr_len == 16 {
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(b"mdat");
        let size = 16u64
            .checked_add(payload)
            .ok_or_else(|| too_large("mdat size overflow"))?;
        bytes.extend_from_slice(&size.to_be_bytes());
    } else {
        // 8 + payload <= u32::MAX on this path, so the sum cannot overflow.
        let size = to_u32(8u64 + payload)?;
        bytes.extend_from_slice(&size.to_be_bytes());
        bytes.extend_from_slice(b"mdat");
    }

    let total_size = (bytes.len() as u64)
        .checked_add(payload)
        .ok_or_else(|| too_large("output size overflow"))?;
    Ok(Header {
        bytes,
        co64,
        total_size,
    })
}

/// Writes header then all sample payloads in chunk order. Returns total bytes written.
pub fn write_mp4<S: Source, K: Sink>(
    plan: &Plan,
    src: &mut S,
    sink: &mut K,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<u64> {
    let header = build_header(plan)?;
    sink.write(&header.bytes)?;

    let total = plan.mdat_payload_size;
    let mut written_payload: u64 = 0;
    let mut scratch = zeroed_buffer(SLICE_BYTES)?;
    let mut staging: Vec<u8> = Vec::new();
    staging
        .try_reserve(FLUSH_BYTES + SLICE_BYTES)
        .map_err(|_| alloc_failed())?;

    for chunk in &plan.chunks {
        let track = plan
            .tracks
            .get(chunk.track)
            .ok_or_else(|| internal("chunk track index out of range"))?;
        let end = chunk
            .first_sample
            .checked_add(chunk.sample_count)
            .ok_or_else(|| internal("chunk sample range overflow"))?;
        let samples = track
            .samples
            .get(chunk.first_sample..end)
            .ok_or_else(|| internal("chunk sample range out of bounds"))?;
        for sample in samples {
            let mut offset = sample.offset;
            let mut left = u64::from(sample.size);
            while left > 0 {
                let n = left.min(SLICE_BYTES as u64) as usize;
                let buf = scratch
                    .get_mut(..n)
                    .ok_or_else(|| internal("scratch bounds"))?;
                src.read_at(offset, buf)?;
                staging.try_reserve(n).map_err(|_| alloc_failed())?;
                staging.extend_from_slice(buf);
                offset = offset
                    .checked_add(n as u64)
                    .ok_or_else(|| internal("source offset overflow"))?;
                left -= n as u64;
                if staging.len() >= FLUSH_BYTES {
                    written_payload = written_payload
                        .checked_add(flush_staging(sink, &mut staging)?)
                        .ok_or_else(|| internal("payload counter overflow"))?;
                    progress(written_payload, total);
                }
            }
        }
    }
    if !staging.is_empty() {
        written_payload = written_payload
            .checked_add(flush_staging(sink, &mut staging)?)
            .ok_or_else(|| internal("payload counter overflow"))?;
        progress(written_payload, total);
    }
    progress(total, total);

    let written = (header.bytes.len() as u64)
        .checked_add(written_payload)
        .ok_or_else(|| internal("written size overflow"))?;
    if written != header.total_size {
        return Err(internal("size mismatch"));
    }
    Ok(header.total_size)
}

// ------------------------------------------------------------------ helpers

fn too_large(msg: &str) -> Error {
    Error::TooLarge(msg.to_string())
}

fn internal(msg: &str) -> Error {
    Error::Io(format!("internal: {msg}"))
}

fn alloc_failed() -> Error {
    too_large("output buffer allocation failed")
}

fn unsupported_track() -> Error {
    Error::Unsupported("track kind cannot be written to MP4".to_string())
}

/// Checked narrowing to a 32-bit field.
fn to_u32<T: TryInto<u32>>(value: T) -> Result<u32> {
    value
        .try_into()
        .map_err(|_| too_large("value exceeds 32-bit field"))
}

fn zeroed_buffer(len: usize) -> Result<Vec<u8>> {
    let mut v: Vec<u8> = Vec::new();
    v.try_reserve_exact(len).map_err(|_| alloc_failed())?;
    v.resize(len, 0);
    Ok(v)
}

/// Sends the staging buffer to the sink and returns how many bytes were sent.
fn flush_staging<K: Sink>(sink: &mut K, staging: &mut Vec<u8>) -> Result<u64> {
    let n = staging.len() as u64;
    sink.write(staging.as_slice())?;
    staging.clear();
    Ok(n)
}

/// Packs an ISO-639-2 code as three 5-bit letters (`c - 0x60`). Anything other than exactly
/// three lowercase ASCII letters is written as "und".
fn pack_language(lang: &str) -> u16 {
    let letters: &[u8] = if lang.len() == 3 && lang.bytes().all(|b| b.is_ascii_lowercase()) {
        lang.as_bytes()
    } else {
        b"und"
    };
    letters
        .iter()
        .fold(0u16, |acc, &b| (acc << 5) | ((u16::from(b) - 0x60) & 31))
}

/// Run-length encodes `values` into `(run_length, value)` pairs.
fn runs<T, I>(values: I) -> Result<Vec<(u32, T)>>
where
    I: IntoIterator<Item = T>,
    T: Copy + PartialEq,
{
    let mut out: Vec<(u32, T)> = Vec::new();
    for value in values {
        let extend = matches!(out.last(), Some((_, last)) if *last == value);
        if extend {
            if let Some((count, _)) = out.last_mut() {
                *count = count
                    .checked_add(1)
                    .ok_or_else(|| too_large("run length overflow"))?;
            }
        } else {
            out.try_reserve(1).map_err(|_| alloc_failed())?;
            out.push((1, value));
        }
    }
    Ok(out)
}

/// Full chunk list of one track, in `plan.chunks` order.
fn chunks_of(plan: &Plan, index: usize) -> impl Iterator<Item = &Chunk> + '_ {
    plan.chunks.iter().filter(move |c| c.track == index)
}

fn chunk_offset(offsets: Offsets, chunk: &Chunk) -> Result<u64> {
    offsets
        .payload_offset
        .checked_add(chunk.rel_offset)
        .ok_or_else(|| too_large("chunk offset overflow"))
}

fn stco_entry(absolute: u64, check: bool) -> Result<u32> {
    match u32::try_from(absolute) {
        Ok(v) => Ok(v),
        Err(_) if !check => Ok(0),
        Err(_) => Err(too_large("chunk offset exceeds 4 GiB; co64 required")),
    }
}

/// tkhd / mdhd / elst-style 16.16 fixed-point width or height.
fn fixed_16_16(value: u32) -> Result<u32> {
    u32::try_from(u64::from(value) << 16)
        .map_err(|_| Error::Unsupported("track dimension does not fit 16.16 fixed point".into()))
}

fn track_duration(track: &PlanTrack) -> Result<u64> {
    track.edits.iter().try_fold(0u64, |acc, edit| {
        acc.checked_add(edit.segment_duration)
            .ok_or_else(|| too_large("track duration overflow"))
    })
}

// ------------------------------------------------------------------ box buffer

/// Growable big-endian byte buffer. Boxes are written in place: `open` reserves the 4-byte
/// size slot and `close` patches it with the exact box length, so sizes are exact by
/// construction and no box is ever copied into its parent.
#[derive(Default)]
struct BoxBuf {
    data: Vec<u8>,
}

impl BoxBuf {
    fn put(&mut self, bytes: &[u8]) -> Result<()> {
        self.data
            .try_reserve(bytes.len())
            .map_err(|_| alloc_failed())?;
        self.data.extend_from_slice(bytes);
        Ok(())
    }

    fn zeros(&mut self, n: usize) -> Result<()> {
        self.data.try_reserve(n).map_err(|_| alloc_failed())?;
        let len = self.data.len() + n;
        self.data.resize(len, 0);
        Ok(())
    }

    fn put_u16(&mut self, v: u16) -> Result<()> {
        self.put(&v.to_be_bytes())
    }

    fn put_u32(&mut self, v: u32) -> Result<()> {
        self.put(&v.to_be_bytes())
    }

    fn put_i32(&mut self, v: i32) -> Result<()> {
        self.put(&v.to_be_bytes())
    }

    fn put_u64(&mut self, v: u64) -> Result<()> {
        self.put(&v.to_be_bytes())
    }

    fn put_i64(&mut self, v: i64) -> Result<()> {
        self.put(&v.to_be_bytes())
    }

    /// Starts a box: writes a placeholder size and the type. Returns the box start.
    fn open(&mut self, kind: &[u8; 4]) -> Result<usize> {
        let start = self.data.len();
        self.put_u32(0)?;
        self.put(kind)?;
        Ok(start)
    }

    /// Finishes the box started at `start` by patching its size field.
    fn close(&mut self, start: usize) -> Result<()> {
        let len = self
            .data
            .len()
            .checked_sub(start)
            .ok_or_else(|| internal("box start past end"))?;
        let size = to_u32(len)?;
        let slot_end = start
            .checked_add(4)
            .ok_or_else(|| internal("box size slot overflow"))?;
        let slot = self
            .data
            .get_mut(start..slot_end)
            .ok_or_else(|| internal("box size slot out of range"))?;
        slot.copy_from_slice(&size.to_be_bytes());
        Ok(())
    }
}

// ------------------------------------------------------------------ boxes

fn build_ftyp(plan: &Plan) -> Result<Vec<u8>> {
    let mut w = BoxBuf::default();
    let ftyp = w.open(b"ftyp")?;
    w.put(b"isom")?;
    w.put_u32(512)?;
    w.put(b"isom")?;
    w.put(b"iso2")?;
    w.put(b"mp41")?;
    if let Some(video) = plan.tracks.iter().find(|t| t.kind == TrackKind::Video) {
        let entry_type = video
            .sample_entry
            .get(4..8)
            .ok_or_else(|| internal("video sample entry too short"))?;
        w.put(entry_type)?;
    }
    w.close(ftyp)?;
    Ok(w.data)
}

fn build_moov_with(plan: &Plan, offsets: Offsets) -> Result<Vec<u8>> {
    let mut w = BoxBuf::default();
    let moov = w.open(b"moov")?;
    let next_track_id = to_u32(plan.tracks.len() as u64 + 1)?;
    write_mvhd(&mut w, plan, next_track_id)?;
    for (index, track) in plan.tracks.iter().enumerate() {
        write_trak(&mut w, plan, index, track, offsets)?;
    }
    w.close(moov)?;
    Ok(w.data)
}

fn put_matrix(w: &mut BoxBuf) -> Result<()> {
    for value in IDENTITY_MATRIX {
        w.put_u32(value)?;
    }
    Ok(())
}

fn write_mvhd(w: &mut BoxBuf, plan: &Plan, next_track_id: u32) -> Result<()> {
    let mvhd = w.open(b"mvhd")?;
    if plan.duration > u64::from(u32::MAX) {
        w.put_u32(VERSION_1)?;
        w.put_u64(0)?;
        w.put_u64(0)?;
        w.put_u32(plan.movie_timescale)?;
        w.put_u64(plan.duration)?;
    } else {
        w.put_u32(0)?;
        w.put_u32(0)?;
        w.put_u32(0)?;
        w.put_u32(plan.movie_timescale)?;
        w.put_u32(to_u32(plan.duration)?)?;
    }
    w.put_u32(0x0001_0000)?; // rate 1.0
    w.put_u16(0x0100)?; // volume 1.0
    w.zeros(10)?; // reserved
    put_matrix(w)?;
    w.zeros(24)?; // pre_defined
    w.put_u32(next_track_id)?;
    w.close(mvhd)
}

fn write_trak(
    w: &mut BoxBuf,
    plan: &Plan,
    index: usize,
    track: &PlanTrack,
    offsets: Offsets,
) -> Result<()> {
    let trak = w.open(b"trak")?;
    write_tkhd(w, track)?;
    write_edts(w, track)?;
    write_mdia(w, plan, index, track, offsets)?;
    w.close(trak)
}

fn write_tkhd(w: &mut BoxBuf, track: &PlanTrack) -> Result<()> {
    let duration = track_duration(track)?;
    let tkhd = w.open(b"tkhd")?;
    if duration > u64::from(u32::MAX) {
        w.put_u32(VERSION_1 | 0x0000_0003)?;
        w.put_u64(0)?; // creation
        w.put_u64(0)?; // modification
        w.put_u32(track.track_id)?;
        w.put_u32(0)?; // reserved
        w.put_u64(duration)?;
    } else {
        w.put_u32(0x0000_0003)?; // enabled | in movie
        w.put_u32(0)?; // creation
        w.put_u32(0)?; // modification
        w.put_u32(track.track_id)?;
        w.put_u32(0)?; // reserved
        w.put_u32(to_u32(duration)?)?;
    }
    w.zeros(8)?; // reserved
    w.put_u16(0)?; // layer
    w.put_u16(0)?; // alternate_group
    let volume: u16 = if track.kind == TrackKind::Audio {
        0x0100
    } else {
        0
    };
    w.put_u16(volume)?;
    w.put_u16(0)?; // reserved
    put_matrix(w)?;
    w.put_u32(fixed_16_16(track.width)?)?;
    w.put_u32(fixed_16_16(track.height)?)?;
    w.close(tkhd)
}

fn write_edts(w: &mut BoxBuf, track: &PlanTrack) -> Result<()> {
    let edts = w.open(b"edts")?;
    let elst = w.open(b"elst")?;
    let wide = track.edits.iter().any(|edit| {
        edit.segment_duration > u64::from(u32::MAX) || i32::try_from(edit.media_time).is_err()
    });
    w.put_u32(if wide { VERSION_1 } else { 0 })?;
    w.put_u32(to_u32(track.edits.len())?)?;
    for edit in &track.edits {
        if wide {
            w.put_u64(edit.segment_duration)?;
            w.put_i64(edit.media_time)?;
        } else {
            w.put_u32(to_u32(edit.segment_duration)?)?;
            let media_time = i32::try_from(edit.media_time)
                .map_err(|_| too_large("media_time exceeds 32-bit field"))?;
            w.put_i32(media_time)?;
        }
        w.put_u16(1)?; // media_rate_integer
        w.put_u16(0)?; // media_rate_fraction
    }
    w.close(elst)?;
    w.close(edts)
}

fn write_mdia(
    w: &mut BoxBuf,
    plan: &Plan,
    index: usize,
    track: &PlanTrack,
    offsets: Offsets,
) -> Result<()> {
    let mdia = w.open(b"mdia")?;
    write_mdhd(w, track)?;
    write_hdlr(w, track)?;
    write_minf(w, plan, index, track, offsets)?;
    w.close(mdia)
}

fn write_mdhd(w: &mut BoxBuf, track: &PlanTrack) -> Result<()> {
    let mdhd = w.open(b"mdhd")?;
    if track.media_duration > u64::from(u32::MAX) {
        w.put_u32(VERSION_1)?;
        w.put_u64(0)?; // creation
        w.put_u64(0)?; // modification
        w.put_u32(track.timescale)?;
        w.put_u64(track.media_duration)?;
    } else {
        w.put_u32(0)?;
        w.put_u32(0)?; // creation
        w.put_u32(0)?; // modification
        w.put_u32(track.timescale)?;
        w.put_u32(to_u32(track.media_duration)?)?;
    }
    w.put_u16(pack_language(&track.language))?;
    w.put_u16(0)?; // pre_defined
    w.close(mdhd)
}

fn write_hdlr(w: &mut BoxBuf, track: &PlanTrack) -> Result<()> {
    let (handler, name): (&[u8], &[u8]) = match track.kind {
        TrackKind::Video => (&b"vide"[..], &b"VideoHandler\0"[..]),
        TrackKind::Audio => (&b"soun"[..], &b"SoundHandler\0"[..]),
        TrackKind::Other => return Err(unsupported_track()),
    };
    let hdlr = w.open(b"hdlr")?;
    w.put_u32(0)?; // version / flags
    w.put_u32(0)?; // pre_defined
    w.put(handler)?;
    w.zeros(12)?; // reserved
    w.put(name)?;
    w.close(hdlr)
}

fn write_minf(
    w: &mut BoxBuf,
    plan: &Plan,
    index: usize,
    track: &PlanTrack,
    offsets: Offsets,
) -> Result<()> {
    let minf = w.open(b"minf")?;
    match track.kind {
        TrackKind::Video => {
            let vmhd = w.open(b"vmhd")?;
            w.put_u32(1)?; // version 0, flags 1
            w.put_u16(0)?; // graphicsmode
            w.zeros(6)?; // opcolor[3]
            w.close(vmhd)?;
        }
        TrackKind::Audio => {
            let smhd = w.open(b"smhd")?;
            w.put_u32(0)?; // version / flags
            w.put_u16(0)?; // balance
            w.put_u16(0)?; // reserved
            w.close(smhd)?;
        }
        TrackKind::Other => return Err(unsupported_track()),
    }
    write_dinf(w)?;
    write_stbl(w, plan, index, track, offsets)?;
    w.close(minf)
}

fn write_dinf(w: &mut BoxBuf) -> Result<()> {
    let dinf = w.open(b"dinf")?;
    let dref = w.open(b"dref")?;
    w.put_u32(0)?; // version / flags
    w.put_u32(1)?; // entry_count
    let url = w.open(b"url ")?;
    w.put_u32(1)?; // flags: media data is in this file
    w.close(url)?;
    w.close(dref)?;
    w.close(dinf)
}

fn write_stbl(
    w: &mut BoxBuf,
    plan: &Plan,
    index: usize,
    track: &PlanTrack,
    offsets: Offsets,
) -> Result<()> {
    let stbl = w.open(b"stbl")?;
    write_stsd(w, track)?;

    let durations = runs(track.samples.iter().map(|s| s.duration))?;
    write_pair_table(w, b"stts", &durations)?;

    if track.samples.iter().any(|s| s.cts_offset != 0) {
        let cts = runs(track.samples.iter().map(|s| s.cts_offset))?;
        write_pair_table(w, b"ctts", &cts)?;
    }

    if track.kind == TrackKind::Video && track.samples.iter().any(|s| !s.keyframe) {
        write_stss(w, track)?;
    }

    write_stsc(w, plan, index)?;
    write_stsz(w, track)?;
    write_chunk_offsets(w, plan, index, offsets)?;
    w.close(stbl)
}

fn write_stsd(w: &mut BoxBuf, track: &PlanTrack) -> Result<()> {
    let stsd = w.open(b"stsd")?;
    w.put_u32(0)?; // version / flags
    w.put_u32(1)?; // entry_count
    w.put(&track.sample_entry)?;
    w.close(stsd)
}

/// stts / ctts: full box with `(count, value)` entries.
fn write_pair_table(w: &mut BoxBuf, kind: &[u8; 4], entries: &[(u32, u32)]) -> Result<()> {
    let table = w.open(kind)?;
    w.put_u32(0)?; // version 0, flags 0
    w.put_u32(to_u32(entries.len())?)?;
    for &(count, value) in entries {
        w.put_u32(count)?;
        w.put_u32(value)?;
    }
    w.close(table)
}

fn write_stss(w: &mut BoxBuf, track: &PlanTrack) -> Result<()> {
    let key_count = to_u32(track.samples.iter().filter(|s| s.keyframe).count())?;
    let stss = w.open(b"stss")?;
    w.put_u32(0)?; // version / flags
    w.put_u32(key_count)?;
    for (i, sample) in track.samples.iter().enumerate() {
        if sample.keyframe {
            // 1-based sample number; i < len <= isize::MAX so i + 1 cannot overflow.
            w.put_u32(to_u32(i + 1)?)?;
        }
    }
    w.close(stss)
}

fn write_stsc(w: &mut BoxBuf, plan: &Plan, index: usize) -> Result<()> {
    let per_chunk_runs = runs(chunks_of(plan, index).map(|c| c.sample_count))?;
    let stsc = w.open(b"stsc")?;
    w.put_u32(0)?; // version / flags
    w.put_u32(to_u32(per_chunk_runs.len())?)?;
    let mut first_chunk: u32 = 1;
    for (chunk_count, samples_per_chunk) in per_chunk_runs {
        w.put_u32(first_chunk)?;
        w.put_u32(to_u32(samples_per_chunk)?)?;
        w.put_u32(1)?; // sample_description_index
        first_chunk = first_chunk
            .checked_add(chunk_count)
            .ok_or_else(|| too_large("chunk count overflow"))?;
    }
    w.close(stsc)
}

fn write_stsz(w: &mut BoxBuf, track: &PlanTrack) -> Result<()> {
    let stsz = w.open(b"stsz")?;
    w.put_u32(0)?; // version / flags
    w.put_u32(0)?; // sample_size: 0 = per-sample table
    w.put_u32(to_u32(track.samples.len())?)?;
    for sample in &track.samples {
        w.put_u32(sample.size)?;
    }
    w.close(stsz)
}

fn write_chunk_offsets(w: &mut BoxBuf, plan: &Plan, index: usize, offsets: Offsets) -> Result<()> {
    let count = to_u32(chunks_of(plan, index).count())?;
    if offsets.co64 {
        let co64 = w.open(b"co64")?;
        w.put_u32(0)?; // version / flags
        w.put_u32(count)?;
        for chunk in chunks_of(plan, index) {
            w.put_u64(chunk_offset(offsets, chunk)?)?;
        }
        w.close(co64)
    } else {
        let stco = w.open(b"stco")?;
        w.put_u32(0)?; // version / flags
        w.put_u32(count)?;
        for chunk in chunks_of(plan, index) {
            let absolute = chunk_offset(offsets, chunk)?;
            w.put_u32(stco_entry(absolute, offsets.check_stco)?)?;
        }
        w.close(stco)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{Edit, PlanSample};

    /// Minimal stsd child: a 86-byte "avc1" box with zeroed body.
    fn entry() -> Vec<u8> {
        let mut e = vec![0u8; 86];
        e[..4].copy_from_slice(&86u32.to_be_bytes());
        e[4..8].copy_from_slice(b"avc1");
        e
    }

    /// One-track plan. `rows` are (size, duration, cts_offset, keyframe); `chunk_counts` lists
    /// samples per chunk.
    fn plan_of(kind: TrackKind, rows: &[(u32, u32, u32, bool)], chunk_counts: &[usize]) -> Plan {
        let mut samples = Vec::new();
        let (mut offset, mut dts) = (0u64, 0u64);
        for &(size, duration, cts_offset, keyframe) in rows {
            samples.push(PlanSample {
                offset,
                size,
                dts,
                duration,
                cts_offset,
                keyframe,
            });
            offset += u64::from(size);
            dts += u64::from(duration);
        }
        let mut chunks = Vec::new();
        let (mut first, mut rel) = (0usize, 0u64);
        for &count in chunk_counts {
            chunks.push(Chunk {
                track: 0,
                first_sample: first,
                sample_count: count,
                rel_offset: rel,
            });
            rel += rows[first..first + count]
                .iter()
                .map(|r| u64::from(r.0))
                .sum::<u64>();
            first += count;
        }
        let track = PlanTrack {
            track_id: 1,
            kind,
            codec_name: "h264".into(),
            language: "eng".into(),
            timescale: 1000,
            media_duration: dts,
            width: 16,
            height: 16,
            channels: 0,
            sample_rate: 0,
            sample_entry: entry(),
            samples,
            edits: vec![Edit {
                segment_duration: dts,
                media_time: 0,
            }],
        };
        Plan {
            movie_timescale: 1000,
            duration: dts,
            tracks: vec![track],
            chunks,
            mdat_payload_size: rel,
            warnings: vec![],
        }
    }

    fn be32(d: &[u8], p: usize) -> u32 {
        u32::from_be_bytes(d[p..p + 4].try_into().unwrap())
    }

    /// First child of type `typ` in `d[start..end]`: returns (payload_start, box_end).
    fn child(d: &[u8], start: usize, end: usize, typ: &str) -> Option<(usize, usize)> {
        let mut pos = start;
        while pos + 8 <= end {
            let size = be32(d, pos) as usize;
            if size < 8 || pos + size > end {
                return None;
            }
            if &d[pos + 4..pos + 8] == typ.as_bytes() {
                return Some((pos + 8, pos + size));
            }
            pos += size;
        }
        None
    }

    /// Descends through `path` starting at the top of `d`; returns the last box's range.
    fn find_path(d: &[u8], path: &[&str]) -> Option<(usize, usize)> {
        let (mut start, mut end) = (0usize, d.len());
        let mut found = None;
        for typ in path {
            let (s, e) = child(d, start, end, typ)?;
            found = Some((s, e));
            start = s;
            end = e;
        }
        found
    }

    /// Checks that every box in `d[start..end]` has a size consistent with its siblings and
    /// that container boxes tile their payload exactly.
    fn check_tree(d: &[u8], start: usize, end: usize) {
        const CONTAINERS: [&str; 7] = ["moov", "trak", "edts", "mdia", "minf", "dinf", "stbl"];
        let mut pos = start;
        while pos < end {
            let size = be32(d, pos) as usize;
            assert!(size >= 8 && pos + size <= end, "bad box size at {pos}");
            let kind = std::str::from_utf8(&d[pos + 4..pos + 8]).unwrap();
            if CONTAINERS.contains(&kind) {
                check_tree(d, pos + 8, pos + size);
            }
            pos += size;
        }
        assert_eq!(pos, end, "children do not tile parent");
    }

    #[test]
    fn box_sizes_are_exact() {
        let plan = plan_of(
            TrackKind::Video,
            &[
                (10, 3600, 0, true),
                (20, 3600, 0, false),
                (30, 1800, 0, false),
            ],
            &[2, 1],
        );
        let moov = build_moov(&plan, 1000, false).unwrap();
        assert_eq!(be32(&moov, 0) as usize, moov.len());
        assert_eq!(&moov[4..8], b"moov");
        check_tree(&moov, 0, moov.len());
        // mvhd v0 is 100 payload bytes + 8 header.
        let (s, e) = find_path(&moov, &["moov", "mvhd"]).unwrap();
        assert_eq!(e - s, 100);
        assert_eq!(e - s + 8, 108);
    }

    #[test]
    fn header_total_size_and_mdat_header() {
        let plan = plan_of(
            TrackKind::Video,
            &[(10, 3600, 0, true), (20, 3600, 0, true)],
            &[2],
        );
        let h = build_header(&plan).unwrap();
        assert!(!h.co64);
        assert_eq!(h.total_size, h.bytes.len() as u64 + plan.mdat_payload_size);
        let n = h.bytes.len();
        assert_eq!(&h.bytes[n - 4..], b"mdat");
        assert_eq!(be32(&h.bytes, n - 8) as u64, 8 + plan.mdat_payload_size);
    }

    #[test]
    fn language_packing() {
        assert_eq!(pack_language("eng"), 0x15C7);
        assert_eq!(pack_language("und"), 0x55C4);
        assert_eq!(pack_language("ENG"), 0x55C4, "uppercase is invalid");
        assert_eq!(pack_language("english"), 0x55C4, "wrong length is invalid");
        assert_eq!(pack_language("e1g"), 0x55C4, "non-letter is invalid");
        assert_eq!(pack_language(""), 0x55C4);
    }

    #[test]
    fn runs_are_run_length_encoded() {
        assert_eq!(runs([5u32, 5, 7, 5]).unwrap(), vec![(2, 5), (1, 7), (1, 5)]);
        assert!(runs(std::iter::empty::<u32>()).unwrap().is_empty());
    }

    #[test]
    fn stts_is_run_length_encoded() {
        let plan = plan_of(
            TrackKind::Video,
            &[(1, 3600, 0, true), (1, 3600, 0, false), (1, 1800, 0, false)],
            &[3],
        );
        let moov = build_moov(&plan, 0, false).unwrap();
        let (s, _) = find_path(&moov, &["moov", "trak", "mdia", "minf", "stbl", "stts"]).unwrap();
        assert_eq!(be32(&moov, s), 0, "version/flags");
        assert_eq!(be32(&moov, s + 4), 2, "two runs");
        assert_eq!((be32(&moov, s + 8), be32(&moov, s + 12)), (2, 3600));
        assert_eq!((be32(&moov, s + 16), be32(&moov, s + 20)), (1, 1800));
    }

    #[test]
    fn stsc_is_run_length_encoded() {
        let plan = plan_of(
            TrackKind::Video,
            &[(1, 1, 0, true), (1, 1, 0, false), (1, 1, 0, false)],
            &[2, 1],
        );
        let moov = build_moov(&plan, 0, false).unwrap();
        let (s, _) = find_path(&moov, &["moov", "trak", "mdia", "minf", "stbl", "stsc"]).unwrap();
        assert_eq!(be32(&moov, s + 4), 2);
        let entry = |i: usize| {
            let p = s + 8 + i * 12;
            (be32(&moov, p), be32(&moov, p + 4), be32(&moov, p + 8))
        };
        assert_eq!(entry(0), (1, 2, 1));
        assert_eq!(entry(1), (2, 1, 1));
    }

    #[test]
    fn ctts_only_when_some_offset_is_nonzero() {
        let path = ["moov", "trak", "mdia", "minf", "stbl", "ctts"];
        let plain = plan_of(TrackKind::Video, &[(1, 1, 0, true), (1, 1, 0, false)], &[2]);
        let moov = build_moov(&plain, 0, false).unwrap();
        assert!(find_path(&moov, &path).is_none());

        let reordered = plan_of(
            TrackKind::Video,
            &[(1, 1, 0, true), (1, 1, 1000, false)],
            &[2],
        );
        let moov = build_moov(&reordered, 0, false).unwrap();
        let (s, _) = find_path(&moov, &path).unwrap();
        assert_eq!(moov[s], 0, "ctts is version 0");
        assert_eq!(be32(&moov, s + 4), 2, "two runs");
        assert_eq!((be32(&moov, s + 8), be32(&moov, s + 12)), (1, 0));
        assert_eq!((be32(&moov, s + 16), be32(&moov, s + 20)), (1, 1000));
    }

    #[test]
    fn elst_switches_to_version_1_only_when_needed() {
        let elst_version = |edits: Vec<Edit>| -> u8 {
            let mut plan = plan_of(TrackKind::Video, &[(1, 1000, 0, true)], &[1]);
            plan.tracks[0].edits = edits;
            let moov = build_moov(&plan, 0, false).unwrap();
            let (s, _) = find_path(&moov, &["moov", "trak", "edts", "elst"]).unwrap();
            moov[s]
        };
        let ordinary = Edit {
            segment_duration: 1000,
            media_time: 0,
        };
        let empty = Edit {
            segment_duration: 1000,
            media_time: -1,
        };
        let huge_segment = Edit {
            segment_duration: u64::from(u32::MAX) + 1,
            media_time: 0,
        };
        let huge_media_time = Edit {
            segment_duration: 1000,
            media_time: i64::from(i32::MAX) + 1,
        };
        assert_eq!(elst_version(vec![ordinary.clone()]), 0);
        assert_eq!(elst_version(vec![empty]), 0, "-1 fits in i32");
        assert_eq!(elst_version(vec![ordinary, huge_segment.clone()]), 1);
        assert_eq!(elst_version(vec![huge_segment]), 1);
        assert_eq!(elst_version(vec![huge_media_time]), 1);
    }

    #[test]
    fn stco_overflow_is_too_large_and_co64_fits() {
        let plan = plan_of(
            TrackKind::Video,
            &[(10, 1, 0, true), (20, 1, 0, true)],
            &[1, 1],
        );
        assert!(matches!(
            build_moov(&plan, u64::from(u32::MAX), false),
            Err(Error::TooLarge(_))
        ));
        assert!(build_moov(&plan, u64::from(u32::MAX) + 1, true).is_ok());
    }
}

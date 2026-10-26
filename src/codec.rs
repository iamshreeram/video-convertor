//! Per-codec preparation: sample entries (stsd children) and codec-specific probing.
//! Internal contract: DESIGN.md "codec.rs internal contract".
// plan.rs consumes these items in a later step; until then they are only exercised by tests.
#![allow(dead_code)]

use crate::error::{Error, Result};
use crate::mkv::{AudioInfo, MkvTrack, SampleRef};
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

const MAX_NALS_PER_SAMPLE: usize = 16;
const OPUS_RATE: u32 = 48_000;
const AAC_TRUNCATED: &str = "AAC configuration not supported (truncated)";
const OPUS_PAD_SKIP: &str = "Opus DiscardPadding not representable";
const FLAC_DURATION_SKIP: &str = "FLAC final frame duration cannot be determined";
const AC3_CHANNELS: [u32; 8] = [2, 1, 2, 3, 3, 4, 4, 5];
/// AAC object types whose GASpecificConfig carries frameLengthFlag.
const AAC_FRAME_LENGTH_AOTS: [u32; 12] = [1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23];

#[allow(dead_code)]
pub(crate) fn prepare_video<S: Source>(t: &MkvTrack, src: &mut S) -> Result<Prep<VideoPrep>> {
    let (codec_name, entry_type, config_type) = match t.codec_id.as_str() {
        "V_MPEG4/ISO/AVC" => ("h264", *b"avc1", *b"avcC"),
        "V_MPEGH/ISO/HEVC" => ("hevc", *b"hev1", *b"hvcC"),
        "V_AV1" => ("av1", *b"av01", *b"av1C"),
        _ => return skip("unsupported codec"),
    };
    let Some(info) = t.video.as_ref() else {
        return skip("missing codec config");
    };
    if t.codec_private.is_empty() {
        return skip("missing codec config");
    }
    let (Ok(width), Ok(height)) = (
        u16::try_from(info.pixel_width),
        u16::try_from(info.pixel_height),
    ) else {
        return skip("video dimensions exceed 65535");
    };
    if t.samples.is_empty() {
        return skip("no samples");
    }
    let entry_type = if codec_name == "hevc" && hvc1_allowed(t, src)? {
        *b"hvc1"
    } else {
        entry_type
    };
    let entry = visual_entry(&entry_type, &config_type, width, height, &t.codec_private)?;
    Ok(Prep::Ok(VideoPrep {
        codec_name,
        entry_type,
        entry,
    }))
}

#[allow(dead_code)]
pub(crate) fn prepare_audio<S: Source>(t: &MkvTrack, src: &mut S) -> Result<Prep<AudioPrep>> {
    let Some(kind) = audio_kind(&t.codec_id) else {
        return skip("unsupported codec");
    };
    let Some(info) = t.audio.as_ref() else {
        return skip("missing audio settings");
    };
    if t.samples.is_empty() {
        return skip("no samples");
    }
    let channels = info.channels.max(1);
    match kind {
        AudioKind::Aac => prepare_aac(t, info, channels),
        AudioKind::Mp3 => prepare_mp3(info, channels),
        AudioKind::Opus => prepare_opus(t, src),
        AudioKind::Flac => prepare_flac(t, info, channels, src),
        AudioKind::Ac3 => prepare_ac3(t, info, src),
    }
}

/// MPEG-4 descriptor length: always 4 bytes. n >= 2^28 -> `Error::TooLarge`.
#[allow(dead_code)]
pub(crate) fn desc_len(n: usize) -> Result<[u8; 4]> {
    if n >= 1usize << 28 {
        return Err(Error::TooLarge(
            "MPEG-4 descriptor length exceeds 2^28 - 1".into(),
        ));
    }
    let n = n as u32;
    Ok([
        0x80 | ((n >> 21) & 0x7F) as u8,
        0x80 | ((n >> 14) & 0x7F) as u8,
        0x80 | ((n >> 7) & 0x7F) as u8,
        (n & 0x7F) as u8,
    ])
}

// ---------------------------------------------------------------- shared helpers

fn skip<T>(reason: &str) -> Result<Prep<T>> {
    Ok(Prep::Skip(reason.to_string()))
}

fn read_vec<S: Source>(src: &mut S, offset: u64, len: usize) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    src.read_at(offset, &mut buf)?;
    Ok(buf)
}

fn field<const N: usize>(d: &[u8], at: usize) -> Option<[u8; N]> {
    d.get(at..at + N)?.try_into().ok()
}

/// Index and reference of the sample with the greatest pts (ties -> later in file order).
fn last_sample(samples: &[SampleRef]) -> Option<(usize, &SampleRef)> {
    samples.iter().enumerate().max_by_key(|(_, s)| s.pts_ns)
}

/// round(ns * rate / 1e9), round half up.
fn ns_to_units(ns: u64, rate: u32) -> u64 {
    ((u128::from(ns) * u128::from(rate) + 500_000_000) / 1_000_000_000) as u64
}

/// Timescale from a Matroska frequency: round, at least 1; invalid -> None.
fn timescale_of(f: f64) -> Option<u32> {
    if !f.is_finite() || f <= 0.0 {
        return None;
    }
    let r = f.round();
    if r > f64::from(u32::MAX) {
        return None;
    }
    Some((r as u32).max(1))
}

fn box_bytes(kind: &[u8; 4], payload: &[u8]) -> Result<Vec<u8>> {
    let size = payload
        .len()
        .checked_add(8)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| Error::TooLarge("box exceeds 4 GiB".into()))?;
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    Ok(out)
}

fn descriptor(tag: u8, body: &[u8]) -> Result<Vec<u8>> {
    let mut out = vec![tag];
    out.extend(desc_len(body.len())?);
    out.extend_from_slice(body);
    Ok(out)
}

/// `esds` box with ES_Descriptor -> DecoderConfigDescriptor (+ optional DecoderSpecificInfo)
/// -> SLConfigDescriptor.
fn esds_box(object_type: u8, dsi: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut dcd_body = vec![object_type, 0x15, 0, 0, 0]; // type, streamType, bufferSizeDB u24
    dcd_body.extend([0u8; 8]); // maxBitrate, avgBitrate
    if let Some(info) = dsi {
        dcd_body.extend(descriptor(0x05, info)?);
    }
    let mut es_body = vec![0u8; 3]; // ES_ID u16 = 0, flags = 0
    es_body.extend(descriptor(0x04, &dcd_body)?);
    es_body.extend(descriptor(0x06, &[0x02])?);
    let mut payload = vec![0u8; 4]; // fullbox version + flags
    payload.extend(descriptor(0x03, &es_body)?);
    box_bytes(b"esds", &payload)
}

/// AudioSampleEntry v0 (28-byte header) + children.
fn audio_entry(
    kind: &[u8; 4],
    channels: u32,
    sample_size: u16,
    rate: u32,
    child: &[u8],
) -> Result<Vec<u8>> {
    let mut payload = vec![0u8; 6];
    payload.extend(1u16.to_be_bytes()); // data_reference_index
    payload.extend([0u8; 8]);
    payload.extend(u16::try_from(channels).unwrap_or(u16::MAX).to_be_bytes());
    payload.extend(sample_size.to_be_bytes());
    payload.extend([0u8; 4]);
    let fixed_rate = if rate <= 65_535 { rate << 16 } else { 0 };
    payload.extend(fixed_rate.to_be_bytes());
    payload.extend_from_slice(child);
    box_bytes(kind, &payload)
}

/// VisualSampleEntry (78-byte header) + config box.
fn visual_entry(
    kind: &[u8; 4],
    config_type: &[u8; 4],
    width: u16,
    height: u16,
    config: &[u8],
) -> Result<Vec<u8>> {
    let mut payload = vec![0u8; 6];
    payload.extend(1u16.to_be_bytes()); // data_reference_index
    payload.extend([0u8; 16]); // pre_defined / reserved
    payload.extend(width.to_be_bytes());
    payload.extend(height.to_be_bytes());
    payload.extend(0x0048_0000u32.to_be_bytes()); // horizresolution 72 dpi
    payload.extend(0x0048_0000u32.to_be_bytes()); // vertresolution 72 dpi
    payload.extend([0u8; 4]); // reserved
    payload.extend(1u16.to_be_bytes()); // frame_count
    payload.extend([0u8; 32]); // compressorname
    payload.extend(0x0018u16.to_be_bytes()); // depth
    payload.extend(0xFFFFu16.to_be_bytes()); // pre_defined = -1
    payload.extend(box_bytes(config_type, config)?);
    box_bytes(kind, &payload)
}

// ---------------------------------------------------------------- video

/// Returns the NAL length-field size when hvcC is structurally valid and carries a
/// completeness-flagged, non-empty array for each of NAL types 32, 33, 34.
fn hvcc_length_size(cp: &[u8]) -> Option<usize> {
    let num_arrays = *cp.get(22)?;
    let length_size = usize::from(*cp.get(21)? & 0x03) + 1;
    let mut pos = 23usize;
    let mut required = [false; 3];
    for _ in 0..num_arrays {
        let header = *cp.get(pos)?;
        if header & 0x40 != 0 {
            return None; // reserved bit must be zero
        }
        let nal_type = header & 0x3F;
        let count = u16::from_be_bytes(field::<2>(cp, pos + 1)?);
        pos += 3;
        for _ in 0..count {
            let len = u16::from_be_bytes(field::<2>(cp, pos)?);
            pos += 2 + usize::from(len);
            if pos > cp.len() {
                return None;
            }
        }
        if (32..=34).contains(&nal_type) && header & 0x80 != 0 && count >= 1 {
            required[usize::from(nal_type - 32)] = true;
        }
    }
    if required.iter().all(|r| *r) {
        Some(length_size)
    } else {
        None
    }
}

/// hvc1 is allowed only with a valid hvcC and no in-band parameter sets in any sample.
fn hvc1_allowed<S: Source>(t: &MkvTrack, src: &mut S) -> Result<bool> {
    let Some(length_size) = hvcc_length_size(&t.codec_private) else {
        return Ok(false);
    };
    for s in &t.samples {
        if !sample_is_clean(src, s, length_size)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Walks the length-prefixed NALs of one sample up to and including its first VCL NAL.
/// Returns Ok(false) on any structural failure, in-band VPS/SPS/PPS, or limit hit.
fn sample_is_clean<S: Source>(src: &mut S, s: &SampleRef, length_size: usize) -> Result<bool> {
    let end = s.offset.saturating_add(u64::from(s.size));
    let mut pos = s.offset;
    for _ in 0..MAX_NALS_PER_SAMPLE {
        if pos == end {
            return Ok(true);
        }
        let Some(nal_start) = pos.checked_add(length_size as u64).filter(|p| *p <= end) else {
            return Ok(false);
        };
        let len_bytes = read_vec(src, pos, length_size)?;
        let nal_len = len_bytes
            .iter()
            .fold(0u64, |acc, b| (acc << 8) | u64::from(*b));
        let Some(nal_end) = nal_start.checked_add(nal_len).filter(|e| *e <= end) else {
            return Ok(false);
        };
        if nal_len < 2 {
            return Ok(false);
        }
        let header = read_vec(src, nal_start, 2)?;
        let Some(&b0) = header.first() else {
            return Ok(false);
        };
        let nal_type = (b0 >> 1) & 0x3F;
        if (32..=34).contains(&nal_type) {
            return Ok(false);
        }
        if nal_type < 32 {
            return Ok(true);
        }
        pos = nal_end;
    }
    Ok(false)
}

// ---------------------------------------------------------------- audio

#[derive(Clone, Copy)]
enum AudioKind {
    Aac,
    Mp3,
    Opus,
    Flac,
    Ac3,
}

fn audio_kind(id: &str) -> Option<AudioKind> {
    if id == "A_AAC" || id.starts_with("A_AAC/") {
        return Some(AudioKind::Aac);
    }
    match id {
        "A_MPEG/L3" => Some(AudioKind::Mp3),
        "A_OPUS" => Some(AudioKind::Opus),
        "A_FLAC" => Some(AudioKind::Flac),
        "A_AC3" => Some(AudioKind::Ac3),
        _ => None,
    }
}

/// MSB-first bit reader over a byte slice; `read` returns None when data runs out.
struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Bits<'_> {
    fn read(&mut self, n: u32) -> Option<u32> {
        let mut value = 0u32;
        for _ in 0..n {
            let byte = *self.data.get(self.pos / 8)?;
            value = (value << 1) | u32::from((byte >> (7 - self.pos % 8)) & 1);
            self.pos += 1;
        }
        Some(value)
    }
}

struct Asc {
    explicit_sbr: bool,
    frame: u32,
}

fn asc_take(bits: &mut Bits, n: u32) -> std::result::Result<u32, String> {
    bits.read(n).ok_or_else(|| AAC_TRUNCATED.to_string())
}

/// aot: 5 bits, 31 -> 32 + next 6 bits.
fn asc_aot(bits: &mut Bits) -> std::result::Result<u32, String> {
    let v = asc_take(bits, 5)?;
    if v == 31 {
        Ok(32 + asc_take(bits, 6)?)
    } else {
        Ok(v)
    }
}

/// sampling frequency index: 4 bits, 15 -> 24-bit explicit frequency follows.
fn asc_freq(bits: &mut Bits) -> std::result::Result<(), String> {
    if asc_take(bits, 4)? == 15 {
        asc_take(bits, 24)?;
    }
    Ok(())
}

fn parse_asc(asc: &[u8]) -> std::result::Result<Asc, String> {
    let mut bits = Bits { data: asc, pos: 0 };
    let mut aot = asc_aot(&mut bits)?;
    asc_freq(&mut bits)?;
    asc_take(&mut bits, 4)?; // channel configuration
    let explicit_sbr = aot == 5 || aot == 29;
    if explicit_sbr {
        asc_freq(&mut bits)?;
        aot = asc_aot(&mut bits)?;
    }
    if !AAC_FRAME_LENGTH_AOTS.contains(&aot) {
        return Err(format!("AAC configuration not supported (aot {aot})"));
    }
    let base = if asc_take(&mut bits, 1)? == 1 {
        960
    } else {
        1024
    };
    Ok(Asc {
        explicit_sbr,
        frame: base,
    })
}

fn prepare_aac(t: &MkvTrack, info: &AudioInfo, channels: u32) -> Result<Prep<AudioPrep>> {
    let asc = match parse_asc(&t.codec_private) {
        Ok(a) => a,
        Err(reason) => return skip(&reason),
    };
    let output = info
        .output_sampling_frequency
        .filter(|o| o.is_finite() && *o > 0.0);
    let implicit_sbr = output.is_some_and(|o| (o - 2.0 * info.sampling_frequency).abs() < 1e-6);
    let sbr = asc.explicit_sbr || implicit_sbr;
    let Some(timescale) = timescale_of(output.unwrap_or(info.sampling_frequency)) else {
        return skip("invalid sampling frequency");
    };
    let frame = if sbr { asc.frame * 2 } else { asc.frame };
    let entry = audio_entry(
        b"mp4a",
        channels,
        16,
        timescale,
        &esds_box(0x40, Some(&t.codec_private))?,
    )?;
    Ok(Prep::Ok(AudioPrep {
        codec_name: "aac",
        entry,
        timescale,
        channels,
        sample_rate: timescale,
        frame: Some(frame),
        last_duration: None,
        trim: 0,
    }))
}

fn prepare_mp3(info: &AudioInfo, channels: u32) -> Result<Prep<AudioPrep>> {
    let Some(timescale) = timescale_of(info.sampling_frequency) else {
        return skip("invalid sampling frequency");
    };
    let frame = if info.sampling_frequency < 32_000.0 {
        576
    } else {
        1152
    };
    let entry = audio_entry(b"mp4a", channels, 16, timescale, &esds_box(0x6B, None)?)?;
    Ok(Prep::Ok(AudioPrep {
        codec_name: "mp3",
        entry,
        timescale,
        channels,
        sample_rate: timescale,
        frame: Some(frame),
        last_duration: None,
        trim: 0,
    }))
}

struct OpusHead {
    channels: u8,
    pre_skip: u16,
    input_rate: u32,
    gain: i16,
    family: u8,
    /// stream_count, coupled_count, mapping (family != 0 only).
    tail: Vec<u8>,
}

fn parse_opus_head(h: &[u8]) -> Option<OpusHead> {
    if h.len() < 19 || !h.starts_with(b"OpusHead") {
        return None;
    }
    let channels = *h.get(9)?;
    if channels == 0 {
        return None;
    }
    let family = *h.get(18)?;
    let tail = if family == 0 {
        Vec::new()
    } else {
        h.get(19..19 + 2 + usize::from(channels))?.to_vec()
    };
    Some(OpusHead {
        channels,
        pre_skip: u16::from_le_bytes(field::<2>(h, 10)?),
        input_rate: u32::from_le_bytes(field::<4>(h, 12)?),
        gain: i16::from_le_bytes(field::<2>(h, 16)?),
        family,
        tail,
    })
}

/// Packet duration in 48 kHz samples from the TOC byte (and the second byte when code 3).
fn opus_packet_units(toc: u8, second: Option<u8>) -> Option<u64> {
    let config = toc >> 3;
    let c = usize::from(config % 4);
    let per_frame: u64 = match config {
        0..=11 => [480, 960, 1920, 2880][c],
        12..=15 => [480, 960][c % 2],
        _ => [120, 240, 480, 960][c],
    };
    let frames: u64 = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => u64::from(second? & 0x3F),
    };
    if frames == 0 {
        return None;
    }
    per_frame.checked_mul(frames)
}

fn opus_last_duration<S: Source>(src: &mut S, last: &SampleRef) -> Result<Option<u64>> {
    if last.size == 0 {
        return Ok(None);
    }
    let n = if last.size >= 2 { 2 } else { 1 };
    let bytes = read_vec(src, last.offset, n)?;
    let Some(&toc) = bytes.first() else {
        return Ok(None);
    };
    Ok(opus_packet_units(toc, bytes.get(1).copied()))
}

fn prepare_opus<S: Source>(t: &MkvTrack, src: &mut S) -> Result<Prep<AudioPrep>> {
    let Some(head) = parse_opus_head(&t.codec_private) else {
        return skip("invalid OpusHead");
    };
    let Some((last_idx, last)) = last_sample(&t.samples) else {
        return skip("no samples");
    };
    if let Some(delay_ns) = t.codec_delay_ns {
        let delay_units = ns_to_units(delay_ns, OPUS_RATE) as i64;
        if (delay_units - i64::from(head.pre_skip)).abs() > 2 {
            return skip("Opus CodecDelay disagrees with OpusHead pre-skip");
        }
    }
    let mut trim = 0u64;
    for (i, s) in t.samples.iter().enumerate() {
        let Some(pad) = s.discard_padding_ns else {
            continue;
        };
        match (i == last_idx, pad) {
            (_, 0) => {}
            (true, p) if p > 0 => {
                trim = ns_to_units(p as u64, OPUS_RATE).min(u64::from(u32::MAX));
            }
            _ => return skip(OPUS_PAD_SKIP),
        }
    }
    let last_duration = opus_last_duration(src, last)?;
    let mut dops = vec![0u8, head.channels];
    dops.extend(head.pre_skip.to_be_bytes());
    dops.extend(head.input_rate.to_be_bytes());
    dops.extend(head.gain.to_be_bytes());
    dops.push(head.family);
    dops.extend_from_slice(&head.tail);
    let channels = u32::from(head.channels);
    let entry = audio_entry(
        b"Opus",
        channels,
        16,
        OPUS_RATE,
        &box_bytes(b"dOps", &dops)?,
    )?;
    Ok(Prep::Ok(AudioPrep {
        codec_name: "opus",
        entry,
        timescale: OPUS_RATE,
        channels,
        sample_rate: OPUS_RATE,
        frame: None,
        last_duration,
        trim,
    }))
}

/// FLAC frame block size in samples from a frame header, or None when unparseable.
fn flac_block_size(buf: &[u8]) -> Option<u64> {
    if *buf.first()? != 0xFF || *buf.get(1)? & 0xFE != 0xF8 {
        return None;
    }
    let code = *buf.get(2)? >> 4;
    match code {
        1 => Some(192),
        2..=5 => Some(576u64 << (code - 2)),
        8..=15 => Some(256u64 << (code - 8)),
        6 | 7 => {
            let first = *buf.get(4)?;
            let utf8_len = match first {
                0x00..=0x7F => 1,
                0xC0..=0xDF => 2,
                0xE0..=0xEF => 3,
                0xF0..=0xF7 => 4,
                0xF8..=0xFB => 5,
                0xFC..=0xFD => 6,
                0xFE => 7,
                _ => return None,
            };
            let at = 4 + utf8_len;
            let value = if code == 6 {
                u64::from(*buf.get(at)?)
            } else {
                let b = buf.get(at..at + 2)?;
                u64::from(u16::from_be_bytes(<[u8; 2]>::try_from(b).ok()?))
            };
            Some(value + 1)
        }
        _ => None,
    }
}

fn prepare_flac<S: Source>(
    t: &MkvTrack,
    info: &AudioInfo,
    channels: u32,
    src: &mut S,
) -> Result<Prep<AudioPrep>> {
    let private = &t.codec_private;
    if !private.starts_with(b"fLaC") || private.len() < 12 {
        return skip("invalid FLAC STREAMINFO");
    }
    let Some(min) = field::<2>(private, 8).map(u16::from_be_bytes) else {
        return skip("invalid FLAC STREAMINFO");
    };
    let Some(max) = field::<2>(private, 10).map(u16::from_be_bytes) else {
        return skip("invalid FLAC STREAMINFO");
    };
    let Some(timescale) = timescale_of(info.sampling_frequency) else {
        return skip("invalid sampling frequency");
    };
    let frame = (min == max && min > 0).then_some(u32::from(min));
    let sample_size = info
        .bit_depth
        .and_then(|b| u16::try_from(b).ok())
        .filter(|b| *b > 0)
        .unwrap_or(16);
    let mut dfla = vec![0u8; 4];
    dfla.extend_from_slice(private.get(4..).unwrap_or_default());
    let entry = audio_entry(
        b"fLaC",
        channels,
        sample_size,
        timescale,
        &box_bytes(b"dfLa", &dfla)?,
    )?;
    let Some((_, last)) = last_sample(&t.samples) else {
        return skip("no samples");
    };
    let n = usize::try_from(last.size.min(16)).unwrap_or(16);
    let head = if n == 0 {
        Vec::new()
    } else {
        read_vec(src, last.offset, n)?
    };
    let last_duration = match flac_block_size(&head) {
        Some(units) => units,
        None => match last.duration_ns {
            Some(ns) => ns_to_units(ns, timescale).max(1),
            None => return skip(FLAC_DURATION_SKIP),
        },
    };
    Ok(Prep::Ok(AudioPrep {
        codec_name: "flac",
        entry,
        timescale,
        channels,
        sample_rate: timescale,
        frame,
        last_duration: Some(last_duration),
        trim: 0,
    }))
}

struct Ac3Frame {
    channels: u32,
    dac3: [u8; 3],
}

fn parse_ac3(data: &[u8]) -> Option<Ac3Frame> {
    let [s0, s1, _, _, b4, b5, b6] = <[u8; 7]>::try_from(data).ok()?;
    if (s0, s1) != (0x0B, 0x77) {
        return None;
    }
    let fscod = b4 >> 6;
    if fscod == 3 {
        return None;
    }
    let frmsizecod = b4 & 0x3F;
    let bsid = b5 >> 3;
    let bsmod = b5 & 0x07;
    let acmod = b6 >> 5;
    // Bit cursor just after acmod (3 bits into byte 6).
    let mut bits = Bits {
        data,
        pos: 6 * 8 + 3,
    };
    if acmod & 0x01 != 0 && acmod != 1 {
        bits.read(2)?; // cmixlev
    }
    if acmod & 0x04 != 0 {
        bits.read(2)?; // surmixlev
    }
    if acmod == 2 {
        bits.read(2)?; // dsurmod
    }
    let lfeon = bits.read(1)?;
    let base = *AC3_CHANNELS.get(usize::from(acmod))?;
    let v: u32 = (u32::from(fscod) << 22)
        | (u32::from(bsid) << 17)
        | (u32::from(bsmod) << 14)
        | (u32::from(acmod) << 11)
        | (lfeon << 10)
        | (u32::from(frmsizecod >> 1) << 5);
    Some(Ac3Frame {
        channels: base + lfeon,
        dac3: [(v >> 16) as u8, (v >> 8) as u8, v as u8],
    })
}

fn prepare_ac3<S: Source>(t: &MkvTrack, info: &AudioInfo, src: &mut S) -> Result<Prep<AudioPrep>> {
    let Some(first) = t.samples.first() else {
        return skip("no samples");
    };
    let head = if first.size < 7 {
        Vec::new()
    } else {
        read_vec(src, first.offset, 7)?
    };
    let Some(frame) = parse_ac3(&head) else {
        return skip("AC-3 syncframe not recognised");
    };
    let Some(timescale) = timescale_of(info.sampling_frequency) else {
        return skip("invalid sampling frequency");
    };
    let entry = audio_entry(
        b"ac-3",
        frame.channels,
        16,
        timescale,
        &box_bytes(b"dac3", &frame.dac3)?,
    )?;
    Ok(Prep::Ok(AudioPrep {
        codec_name: "ac3",
        entry,
        timescale,
        channels: frame.channels,
        sample_rate: timescale,
        frame: Some(1536),
        last_duration: None,
        trim: 0,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mkv::{AudioInfo, TrackKind, VideoInfo};
    use crate::source::SliceSource;

    const AVCC: [u8; 15] = [1, 66, 0, 30, 0xFF, 0xE1, 0, 4, 0x67, 1, 2, 3, 1, 0, 0];
    const ASC_LC_48K_STEREO: [u8; 2] = [0x11, 0x90];

    fn base_track(codec_id: &str, private: Vec<u8>, kind: TrackKind) -> MkvTrack {
        MkvTrack {
            number: 1,
            kind,
            codec_id: codec_id.into(),
            codec_private: private,
            language: "und".into(),
            default_duration_ns: None,
            codec_delay_ns: None,
            seek_pre_roll_ns: None,
            video: None,
            audio: None,
            laced: false,
            content_encoded: false,
            samples: Vec::new(),
        }
    }

    fn video_track(codec_id: &str, private: Vec<u8>) -> MkvTrack {
        let mut t = base_track(codec_id, private, TrackKind::Video);
        t.video = Some(VideoInfo {
            pixel_width: 320,
            pixel_height: 240,
            display_width: None,
            display_height: None,
        });
        t
    }

    fn audio_track(codec_id: &str, private: Vec<u8>, sf: f64, ch: u32) -> MkvTrack {
        let mut t = base_track(codec_id, private, TrackKind::Audio);
        t.audio = Some(AudioInfo {
            sampling_frequency: sf,
            output_sampling_frequency: None,
            channels: ch,
            bit_depth: None,
        });
        t
    }

    /// Concatenates payloads into a byte image and builds matching SampleRefs (pts in ms).
    fn layout(payloads: &[Vec<u8>], pts_ms: &[i64]) -> (Vec<u8>, Vec<SampleRef>) {
        let mut data = Vec::new();
        let mut refs = Vec::new();
        for (p, ms) in payloads.iter().zip(pts_ms) {
            refs.push(SampleRef {
                offset: data.len() as u64,
                size: p.len() as u32,
                pts_ns: ms * 1_000_000,
                keyframe: true,
                duration_ns: None,
                discard_padding_ns: None,
            });
            data.extend_from_slice(p);
        }
        (data, refs)
    }

    fn prep_video(t: &MkvTrack, data: &[u8]) -> VideoPrep {
        match prepare_video(t, &mut SliceSource(data)).expect("io") {
            Prep::Ok(v) => v,
            Prep::Skip(r) => panic!("unexpected skip: {r}"),
        }
    }

    fn skip_video(t: &MkvTrack, data: &[u8]) -> String {
        match prepare_video(t, &mut SliceSource(data)).expect("io") {
            Prep::Skip(r) => r,
            Prep::Ok(_) => panic!("expected skip"),
        }
    }

    fn prep_audio(t: &MkvTrack, data: &[u8]) -> AudioPrep {
        match prepare_audio(t, &mut SliceSource(data)).expect("io") {
            Prep::Ok(a) => a,
            Prep::Skip(r) => panic!("unexpected skip: {r}"),
        }
    }

    fn skip_audio(t: &MkvTrack, data: &[u8]) -> String {
        match prepare_audio(t, &mut SliceSource(data)).expect("io") {
            Prep::Skip(r) => r,
            Prep::Ok(_) => panic!("expected skip"),
        }
    }

    /// Returns the payload of the first child box of `kind` in `d[start..]`.
    fn find_box<'a>(d: &'a [u8], start: usize, kind: &[u8; 4]) -> Option<&'a [u8]> {
        let mut pos = start;
        while pos + 8 <= d.len() {
            let size = u32::from_be_bytes([d[pos], d[pos + 1], d[pos + 2], d[pos + 3]]) as usize;
            if size < 8 || pos + size > d.len() {
                return None;
            }
            if &d[pos + 4..pos + 8] == kind {
                return Some(&d[pos + 8..pos + size]);
            }
            pos += size;
        }
        None
    }

    /// Decodes one 4-byte-length descriptor at `pos`: (tag, body start, body end).
    fn desc_at(d: &[u8], pos: usize) -> (u8, usize, usize) {
        let tag = d[pos];
        let mut len = 0usize;
        let mut p = pos + 1;
        loop {
            let b = d[p];
            p += 1;
            len = (len << 7) | usize::from(b & 0x7F);
            if b & 0x80 == 0 {
                break;
            }
        }
        assert_eq!(p - (pos + 1), 4, "descriptor length must use 4 bytes");
        (tag, p, p + len)
    }

    struct Esds {
        object_type: u8,
        dsi: Option<Vec<u8>>,
    }

    /// Parses the esds of an mp4a entry and asserts the descriptor nesting is exact.
    fn parse_esds(entry: &[u8]) -> Esds {
        let esds = find_box(&entry[36..], 0, b"esds").expect("esds");
        let (t3, es_s, es_e) = desc_at(esds, 4);
        assert_eq!(t3, 3);
        assert_eq!(es_e, esds.len(), "ES_Descriptor spans the esds payload");
        assert_eq!(&esds[es_s..es_s + 3], &[0, 0, 0]);
        let (t4, dc_s, dc_e) = desc_at(esds, es_s + 3);
        assert_eq!(t4, 4);
        assert_eq!(esds[dc_s + 1], 0x15);
        let object_type = esds[dc_s];
        let mut p = dc_s + 13;
        let mut dsi = None;
        if p < dc_e {
            let (t5, s5, e5) = desc_at(esds, p);
            assert_eq!(t5, 5);
            dsi = Some(esds[s5..e5].to_vec());
            p = e5;
        }
        assert_eq!(p, dc_e, "DecoderConfigDescriptor exact length");
        let (t6, s6, e6) = desc_at(esds, dc_e);
        assert_eq!(t6, 6);
        assert_eq!(&esds[s6..e6], &[0x02]);
        assert_eq!(e6, es_e, "SLConfig is the last child");
        Esds { object_type, dsi }
    }

    fn hevc_nal(typ: u8, body: &[u8]) -> Vec<u8> {
        let mut n = vec![typ << 1, 0x01];
        n.extend_from_slice(body);
        let mut v = (n.len() as u32).to_be_bytes().to_vec();
        v.extend(n);
        v
    }

    fn hvcc(arrays: &[(bool, u8, Vec<u8>)]) -> Vec<u8> {
        let mut v = vec![0u8; 22];
        v[0] = 1;
        v[21] = 0x03;
        v.push(arrays.len() as u8);
        for (complete, typ, nal) in arrays {
            v.push(((*complete as u8) << 7) | typ);
            v.extend(1u16.to_be_bytes());
            v.extend((nal.len() as u16).to_be_bytes());
            v.extend_from_slice(nal);
        }
        v
    }

    fn hvcc_complete() -> Vec<u8> {
        hvcc(&[
            (true, 32, vec![0x40, 1, 1]),
            (true, 33, vec![0x42, 1, 1]),
            (true, 34, vec![0x44, 1, 1]),
        ])
    }

    fn idr(body: u8) -> Vec<u8> {
        hevc_nal(19, &[body, 1, 2, 3])
    }

    fn trail(body: u8) -> Vec<u8> {
        hevc_nal(1, &[body, 9, 9])
    }

    fn hevc_entry_type(cp: Vec<u8>, frames: Vec<Vec<u8>>) -> [u8; 4] {
        let pts: Vec<i64> = (0..frames.len() as i64).map(|i| i * 40).collect();
        let (data, refs) = layout(&frames, &pts);
        let mut t = video_track("V_MPEGH/ISO/HEVC", cp);
        t.samples = refs;
        prep_video(&t, &data).entry_type
    }

    #[test]
    fn avc_entry_bytes_and_sizes() {
        let (data, refs) = layout(&[vec![0u8; 20]], &[0]);
        let mut t = video_track("V_MPEG4/ISO/AVC", AVCC.to_vec());
        t.samples = refs;
        let v = prep_video(&t, &data);
        assert_eq!(v.codec_name, "h264");
        assert_eq!(v.entry_type, *b"avc1");
        assert_eq!(v.entry.len(), 8 + 78 + 8 + AVCC.len());
        assert_eq!(&v.entry[4..8], b"avc1");
        assert_eq!(find_box(&v.entry[86..], 0, b"avcC"), Some(&AVCC[..]));
        assert_eq!(u16::from_be_bytes([v.entry[32], v.entry[33]]), 320);
        assert_eq!(u16::from_be_bytes([v.entry[34], v.entry[35]]), 240);
    }

    #[test]
    fn av1_entry_bytes_and_sizes() {
        let av1c = vec![0x81, 0x00, 0x0C, 0x00, 0x0A, 0x0B, 0x00, 0x00, 0x00];
        let (data, refs) = layout(&[vec![0u8; 10]], &[0]);
        let mut t = video_track("V_AV1", av1c.clone());
        t.samples = refs;
        let v = prep_video(&t, &data);
        assert_eq!((v.codec_name, v.entry_type), ("av1", *b"av01"));
        assert_eq!(v.entry.len(), 8 + 78 + 8 + av1c.len());
        assert_eq!(find_box(&v.entry[86..], 0, b"av1C"), Some(&av1c[..]));
    }

    #[test]
    fn video_skips() {
        let (data, refs) = layout(&[vec![0u8; 10]], &[0]);
        let mut t = video_track("V_VP9", vec![1, 2]);
        t.samples = refs.clone();
        assert_eq!(skip_video(&t, &data), "unsupported codec");
        let mut t = base_track("V_MPEG4/ISO/AVC", AVCC.to_vec(), TrackKind::Video);
        t.samples = refs.clone();
        assert_eq!(skip_video(&t, &data), "missing codec config");
        let mut t = video_track("V_MPEG4/ISO/AVC", vec![]);
        t.samples = refs.clone();
        assert_eq!(skip_video(&t, &data), "missing codec config");
        let t = video_track("V_MPEG4/ISO/AVC", AVCC.to_vec());
        assert_eq!(skip_video(&t, &data), "no samples");
    }

    #[test]
    fn hvc1_vs_hev1_matrix() {
        let plain = vec![idr(1), trail(2), idr(3)];
        assert_eq!(hevc_entry_type(hvcc_complete(), plain.clone()), *b"hvc1");

        // in-band VPS/SPS/PPS in the first sample
        let mut inband_first = plain.clone();
        inband_first[0] = [
            hevc_nal(32, &[1]),
            hevc_nal(33, &[1]),
            hevc_nal(34, &[1]),
            idr(1),
        ]
        .concat();
        assert_eq!(hevc_entry_type(hvcc_complete(), inband_first), *b"hev1");

        // in-band SPS only in a LATER keyframe
        let mut inband_later = plain.clone();
        inband_later[2] = [hevc_nal(33, &[7]), idr(3)].concat();
        assert_eq!(hevc_entry_type(hvcc_complete(), inband_later), *b"hev1");

        // completeness bit cleared on a required array
        let incomplete = hvcc(&[
            (true, 32, vec![0x40, 1, 1]),
            (false, 33, vec![0x42, 1, 1]),
            (true, 34, vec![0x44, 1, 1]),
        ]);
        assert_eq!(hevc_entry_type(incomplete, plain.clone()), *b"hev1");

        // missing PPS array
        let missing = hvcc(&[(true, 32, vec![0x40, 1, 1]), (true, 33, vec![0x42, 1, 1])]);
        assert_eq!(hevc_entry_type(missing, plain.clone()), *b"hev1");

        // truncated hvcC
        let mut truncated = hvcc_complete();
        truncated.truncate(truncated.len() - 2);
        assert_eq!(hevc_entry_type(truncated, plain.clone()), *b"hev1");

        // garbage NAL length in a sample
        let mut garbage = plain.clone();
        garbage[1] = vec![0xFF, 0xFF, 0xFF, 0xFF, 1, 2, 3];
        assert_eq!(hevc_entry_type(hvcc_complete(), garbage), *b"hev1");
    }

    #[test]
    fn hvc1_limit_of_sixteen_nals() {
        let sei = |n: usize| -> Vec<u8> { (0..n).flat_map(|_| hevc_nal(39, &[0xAA])).collect() };
        // 15 non-VCL NALs then the VCL: within the limit -> hvc1
        let ok = vec![[sei(15), idr(1)].concat()];
        assert_eq!(hevc_entry_type(hvcc_complete(), ok), *b"hvc1");
        // 16 non-VCL NALs without a VCL reached: limit hit -> hev1
        let over = vec![sei(16)];
        assert_eq!(hevc_entry_type(hvcc_complete(), over), *b"hev1");
    }

    #[test]
    fn hvcc_structure_rejects_reserved_bit_and_bad_count() {
        let mut bad = hvcc_complete();
        bad[23] |= 0x40; // reserved bit in first array header
        assert!(hvcc_length_size(&bad).is_none());
        assert_eq!(hvcc_length_size(&hvcc_complete()), Some(4));
        assert!(hvcc_length_size(&[1u8; 10]).is_none());
    }

    #[test]
    fn desc_len_boundaries() {
        for n in [0usize, 127, 128, 16383, 16384, (1 << 28) - 1] {
            let b = desc_len(n).expect("ok");
            assert!(b[0] & 0x80 != 0 && b[1] & 0x80 != 0 && b[2] & 0x80 != 0);
            assert_eq!(b[3] & 0x80, 0);
            let decoded = b
                .iter()
                .fold(0usize, |a, x| (a << 7) | usize::from(x & 0x7F));
            assert_eq!(decoded, n);
        }
        assert_eq!(desc_len(0).unwrap(), [0x80, 0x80, 0x80, 0x00]);
        assert_eq!(desc_len(127).unwrap(), [0x80, 0x80, 0x80, 0x7F]);
        assert_eq!(desc_len(128).unwrap(), [0x80, 0x80, 0x81, 0x00]);
        assert!(matches!(desc_len(1 << 28), Err(Error::TooLarge(_))));
    }

    #[test]
    fn aac_lc_and_frame_length_flag() {
        let (data, refs) = layout(&vec![vec![0u8; 30]; 3], &[0, 21, 42]);
        let mut t = audio_track("A_AAC", ASC_LC_48K_STEREO.to_vec(), 48000.0, 2);
        t.samples = refs.clone();
        let a = prep_audio(&t, &data);
        assert_eq!(
            (a.codec_name, a.timescale, a.sample_rate),
            ("aac", 48000, 48000)
        );
        assert_eq!((a.frame, a.channels, a.trim), (Some(1024), 2, 0));
        assert_eq!(&a.entry[4..8], b"mp4a");
        assert_eq!(parse_esds(&a.entry).object_type, 0x40);
        assert_eq!(
            parse_esds(&a.entry).dsi.as_deref(),
            Some(&ASC_LC_48K_STEREO[..])
        );

        // frameLengthFlag set -> 960
        let mut t = audio_track("A_AAC/MPEG4/LC", vec![0x11, 0x94], 48000.0, 2);
        t.samples = refs;
        assert_eq!(prep_audio(&t, &data).frame, Some(960));
    }

    #[test]
    fn aac_explicit_and_implicit_sbr() {
        let (data, refs) = layout(&vec![vec![0u8; 30]; 4], &[0, 43, 85, 128]);
        let mut t = audio_track("A_AAC", vec![0x2B, 0x11, 0x88, 0x00], 24000.0, 2);
        t.audio.as_mut().unwrap().output_sampling_frequency = Some(48000.0);
        t.samples = refs.clone();
        let a = prep_audio(&t, &data);
        assert_eq!(
            (a.timescale, a.sample_rate, a.frame),
            (48000, 48000, Some(2048))
        );
        assert_eq!(be_u32_at(&a.entry, 8 + 24), 48000 << 16);

        let mut t = audio_track("A_AAC", vec![0x13, 0x10], 24000.0, 2);
        t.audio.as_mut().unwrap().output_sampling_frequency = Some(48000.0);
        t.samples = refs;
        let a = prep_audio(&t, &data);
        assert_eq!((a.timescale, a.frame), (48000, Some(2048)));
    }

    fn be_u32_at(d: &[u8], at: usize) -> u32 {
        u32::from_be_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
    }

    #[test]
    fn aac_unsupported_and_truncated_skip() {
        let (data, refs) = layout(&[vec![0u8; 30]], &[0]);
        let mut t = audio_track("A_AAC", vec![0x40, 0x10], 48000.0, 2);
        t.samples = refs.clone();
        assert_eq!(
            skip_audio(&t, &data),
            "AAC configuration not supported (aot 8)"
        );
        let mut t = audio_track("A_AAC", vec![], 48000.0, 2);
        t.samples = refs.clone();
        assert_eq!(skip_audio(&t, &data), AAC_TRUNCATED);
        let mut t = audio_track("A_AAC", vec![0x11], 48000.0, 2);
        t.samples = refs;
        assert_eq!(skip_audio(&t, &data), AAC_TRUNCATED);
    }

    #[test]
    fn esds_lengths_127_128_16384_round_trip() {
        for n in [127usize, 128, 16384] {
            let mut asc = ASC_LC_48K_STEREO.to_vec();
            asc.resize(n, 0);
            let (data, refs) = layout(&[vec![0u8; 30]], &[0]);
            let mut t = audio_track("A_AAC", asc.clone(), 48000.0, 2);
            t.samples = refs;
            let a = prep_audio(&t, &data);
            let e = parse_esds(&a.entry);
            assert_eq!(e.dsi.as_deref(), Some(&asc[..]), "n={n}");
        }
    }

    #[test]
    fn mp3_frame_sizes_and_esds() {
        let (data, refs) = layout(&vec![vec![0u8; 417]; 5], &[0, 26, 52, 78, 104]);
        let mut t = audio_track("A_MPEG/L3", vec![], 44100.0, 2);
        t.samples = refs.clone();
        let a = prep_audio(&t, &data);
        assert_eq!(
            (a.timescale, a.sample_rate, a.frame),
            (44100, 44100, Some(1152))
        );
        assert_eq!(&a.entry[4..8], b"mp4a");
        let e = parse_esds(&a.entry);
        assert_eq!(e.object_type, 0x6B);
        assert!(e.dsi.is_none());

        let mut t = audio_track("A_MPEG/L3", vec![], 22050.0, 1);
        t.samples = refs;
        let a = prep_audio(&t, &data);
        assert_eq!((a.timescale, a.frame), (22050, Some(576)));
    }

    fn opus_track(head: Vec<u8>, delay: Option<u64>) -> MkvTrack {
        let mut t = audio_track("A_OPUS", head, 48000.0, 2);
        t.codec_delay_ns = delay;
        t
    }

    /// Five 20 ms CELT packets (TOC 0xF8) at 0,20,...,80 ms.
    fn opus_packets(last_pad: Option<i64>) -> (Vec<u8>, Vec<SampleRef>) {
        let payloads: Vec<Vec<u8>> = (0..5)
            .map(|i| {
                let mut p = vec![0xF8u8];
                p.extend(vec![i as u8; 19]);
                p
            })
            .collect();
        let pts: Vec<i64> = (0..5).map(|i| i * 20).collect();
        let (data, mut refs) = layout(&payloads, &pts);
        if let Some(pad) = last_pad {
            refs[4].discard_padding_ns = Some(pad);
        }
        (data, refs)
    }

    #[test]
    fn opus_family0_dops_trim_and_toc() {
        let (data, refs) = opus_packets(Some(10_000_000));
        let mut t = opus_track(opus_head(2, 312, 44100, -256, 0, &[]), Some(6_500_000));
        t.samples = refs;
        let a = prep_audio(&t, &data);
        assert_eq!(
            (a.entry[4..8].to_vec(), a.timescale),
            (b"Opus".to_vec(), 48000)
        );
        assert_eq!(
            find_box(&a.entry[36..], 0, b"dOps"),
            Some(&[0u8, 2, 0x01, 0x38, 0, 0, 0xAC, 0x44, 0xFF, 0x00, 0][..])
        );
        assert_eq!(a.trim, 480);
        assert_eq!(a.last_duration, Some(960));
        assert_eq!(a.frame, None);
        assert_eq!(a.channels, 2);
        assert_eq!(be_u32_at(&a.entry, 8 + 24), 48000 << 16);
    }

    #[test]
    fn opus_family1_dops_with_mapping() {
        let (data, refs) = opus_packets(None);
        let mut t = opus_track(opus_head(2, 312, 48000, 0, 1, &[2, 0, 0, 1]), None);
        t.samples = refs;
        let a = prep_audio(&t, &data);
        assert_eq!(
            find_box(&a.entry[36..], 0, b"dOps"),
            Some(&[0u8, 2, 0x01, 0x38, 0, 0, 0xBB, 0x80, 0, 0, 1, 2, 0, 0, 1][..])
        );
        assert_eq!(a.trim, 0);
    }

    #[test]
    fn opus_family1_short_tail_skips() {
        let (data, refs) = opus_packets(None);
        let mut t = opus_track(opus_head(2, 312, 48000, 0, 1, &[2, 0]), None);
        t.samples = refs;
        assert_eq!(skip_audio(&t, &data), "invalid OpusHead");
    }

    #[test]
    fn opus_skips_and_bad_head() {
        let (data, refs) = opus_packets(None);
        let mut t = opus_track(opus_head(2, 312, 48000, 0, 0, &[]), Some(20_000_000));
        t.samples = refs.clone();
        assert_eq!(
            skip_audio(&t, &data),
            "Opus CodecDelay disagrees with OpusHead pre-skip"
        );

        let (data, refs) = opus_packets(Some(-5_000_000));
        let mut t = opus_track(opus_head(2, 312, 48000, 0, 0, &[]), Some(6_500_000));
        t.samples = refs;
        assert_eq!(skip_audio(&t, &data), OPUS_PAD_SKIP);

        let (data, mut refs) = opus_packets(None);
        refs[1].discard_padding_ns = Some(5_000_000);
        let mut t = opus_track(opus_head(2, 312, 48000, 0, 0, &[]), None);
        t.samples = refs;
        assert_eq!(skip_audio(&t, &data), OPUS_PAD_SKIP);

        let mut t = opus_track(b"NotOpus!".to_vec(), None);
        t.samples = refs_of_one(&data);
        assert_eq!(skip_audio(&t, &data), "invalid OpusHead");
    }

    fn refs_of_one(data: &[u8]) -> Vec<SampleRef> {
        vec![SampleRef {
            offset: 0,
            size: data.len() as u32,
            pts_ns: 0,
            keyframe: true,
            duration_ns: None,
            discard_padding_ns: None,
        }]
    }

    #[test]
    fn opus_toc_units() {
        assert_eq!(opus_packet_units(0xF8, None), Some(960));
        assert_eq!(opus_packet_units(0x03, Some(0x02)), Some(960)); // config 0 (10 ms) x2
        assert_eq!(opus_packet_units(0x03, Some(0x03)), Some(1440));
        assert_eq!(opus_packet_units(0x03, Some(0x00)), None);
        assert_eq!(opus_packet_units(0x03, None), None);
        assert_eq!(opus_packet_units(0x80, None), Some(120)); // config 16, 2.5 ms
        assert_eq!(opus_packet_units(0x04, None), Some(480)); // config 0 (10 ms), code 0 -> 1 frame
    }

    fn opus_head(
        channels: u8,
        pre_skip: u16,
        rate: u32,
        gain: i16,
        family: u8,
        tail: &[u8],
    ) -> Vec<u8> {
        let mut v = b"OpusHead".to_vec();
        v.push(1);
        v.push(channels);
        v.extend(pre_skip.to_le_bytes());
        v.extend(rate.to_le_bytes());
        v.extend(gain.to_le_bytes());
        v.push(family);
        v.extend_from_slice(tail);
        v
    }

    fn flac_private(min: u16, max: u16) -> Vec<u8> {
        let mut v = b"fLaC".to_vec();
        v.extend([0x80, 0, 0, 34]);
        v.extend(min.to_be_bytes());
        v.extend(max.to_be_bytes());
        v.extend([0u8; 6]);
        v.extend([0x0A, 0xC4, 0x42, 0xF0, 0, 0, 0, 0]);
        v.extend([0u8; 16]);
        v
    }

    fn flac_frame(block_size: u32, filler: usize) -> Vec<u8> {
        let mut v = vec![0xFF, 0xF8];
        match block_size {
            4096 => {
                v.push(0xC9);
                v.push(0x18);
                v.push(0x00);
            }
            n => {
                v.push(0x79);
                v.push(0x18);
                v.push(0x00);
                v.extend(((n - 1) as u16).to_be_bytes());
            }
        }
        v.push(0x00);
        v.extend(vec![0xAB; filler]);
        v
    }

    #[test]
    fn flac_fixed_block_and_last_frame_header() {
        let frames = vec![
            flac_frame(4096, 100),
            flac_frame(4096, 100),
            flac_frame(1000, 100),
        ];
        let (data, refs) = layout(&frames, &[0, 93, 186]);
        let mut t = audio_track("A_FLAC", flac_private(4096, 4096), 44100.0, 2);
        t.samples = refs;
        let a = prep_audio(&t, &data);
        assert_eq!(
            (a.entry[4..8].to_vec(), a.timescale),
            (b"fLaC".to_vec(), 44100)
        );
        assert_eq!(a.frame, Some(4096));
        assert_eq!(a.last_duration, Some(1000));
        let dfla = find_box(&a.entry[36..], 0, b"dfLa").expect("dfLa");
        assert_eq!(&dfla[..4], &[0, 0, 0, 0]);
        assert_eq!(&dfla[4..], &flac_private(4096, 4096)[4..]);
    }

    #[test]
    fn flac_variable_block_and_fallbacks() {
        let frames = vec![
            flac_frame(4096, 100),
            flac_frame(4096, 100),
            flac_frame(1000, 100),
        ];
        let (data, refs) = layout(&frames, &[0, 93, 186]);
        let mut t = audio_track("A_FLAC", flac_private(16, 4096), 44100.0, 2);
        t.samples = refs.clone();
        let a = prep_audio(&t, &data);
        assert_eq!(a.frame, None);
        assert_eq!(a.last_duration, Some(1000));

        // unparseable last frame, duration_ns fallback: 10 ms -> 441 units
        let mut bad = vec![0x00u8; 50];
        bad[0] = 0x12;
        let (data, mut refs) = layout(&[flac_frame(4096, 10), bad], &[0, 93]);
        refs[1].duration_ns = Some(10_000_000);
        let mut t = audio_track("A_FLAC", flac_private(4096, 4096), 44100.0, 2);
        t.samples = refs.clone();
        assert_eq!(prep_audio(&t, &data).last_duration, Some(441));

        // unparseable without duration -> skipped with FLAC in the reason
        refs[1].duration_ns = None;
        t.samples = refs;
        let reason = skip_audio(&t, &data);
        assert!(reason.contains("FLAC"), "{reason}");
    }

    #[test]
    fn flac_short_streaminfo_skips() {
        let (data, refs) = layout(&[flac_frame(4096, 10)], &[0]);
        let mut t = audio_track("A_FLAC", b"fLaC\x80\x00\x00".to_vec(), 44100.0, 2);
        t.samples = refs;
        assert!(skip_audio(&t, &data).contains("FLAC"));
    }

    fn ac3_frame() -> Vec<u8> {
        let mut v = vec![0x0B, 0x77, 0, 0, 0x0A, 0x40, 0xE1];
        v.extend(vec![0x55; 40]);
        v
    }

    #[test]
    fn ac3_dac3_and_channels() {
        let frames = vec![ac3_frame(); 4];
        let (data, refs) = layout(&frames, &[0, 32, 64, 96]);
        let mut t = audio_track("A_AC3", vec![], 48000.0, 6);
        t.samples = refs;
        let a = prep_audio(&t, &data);
        assert_eq!(
            (a.entry[4..8].to_vec(), a.timescale),
            (b"ac-3".to_vec(), 48000)
        );
        assert_eq!(
            find_box(&a.entry[36..], 0, b"dac3"),
            Some(&[0x10u8, 0x3C, 0xA0][..])
        );
        assert_eq!(u16::from_be_bytes([a.entry[24], a.entry[25]]), 6);
        assert_eq!(a.channels, 6);
        assert_eq!(a.frame, Some(1536));
    }

    #[test]
    fn ac3_stereo_and_bad_sync() {
        let mut stereo = ac3_frame();
        stereo[6] = 0x40; // acmod 2, no LFE
        let (data, refs) = layout(&[stereo], &[0]);
        let mut t = audio_track("A_AC3", vec![], 48000.0, 2);
        t.samples = refs;
        assert_eq!(prep_audio(&t, &data).channels, 2);

        let (data, refs) = layout(&[vec![1, 2, 3, 4, 5, 6, 7, 8, 9]], &[0]);
        let mut t = audio_track("A_AC3", vec![], 48000.0, 6);
        t.samples = refs;
        assert_eq!(skip_audio(&t, &data), "AC-3 syncframe not recognised");
    }

    #[test]
    fn unsupported_audio_and_missing_settings() {
        let (data, refs) = layout(&[vec![0u8; 10]], &[0]);
        let mut t = audio_track("A_VORBIS", vec![], 48000.0, 2);
        t.samples = refs.clone();
        assert_eq!(skip_audio(&t, &data), "unsupported codec");
        let mut t = base_track("A_OPUS", vec![], TrackKind::Audio);
        t.samples = refs.clone();
        assert_eq!(skip_audio(&t, &data), "missing audio settings");
        let t = audio_track("A_OPUS", opus_head(2, 312, 48000, 0, 0, &[]), 48000.0, 2);
        assert_eq!(skip_audio(&t, &data), "no samples");
    }
}

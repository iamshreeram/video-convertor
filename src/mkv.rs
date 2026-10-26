//! Pass 1: walks Matroska/WebM EBML structure and records per-track sample references.
//! Payloads are never read here; see DESIGN.md "MKV scan rules".

use std::collections::HashMap;

use crate::ebml::{self, Header, MAX_HEADER_LEN};
use crate::error::{Error, Result};
use crate::source::{BufferedSource, Source};

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
    src: &mut S,
    progress: &mut dyn FnMut(u64, u64),
    limits: &Limits,
) -> Result<Mkv> {
    let len = src.len();
    let mut window = BufferedSource::new_adaptive(&mut *src, READ_MIN_WINDOW, READ_MAX_WINDOW);
    let mut scanner = Scanner::new(limits.max_samples);
    let truncated = scanner.run(&mut window, progress)?;
    let mkv = scanner.into_mkv(truncated)?;
    progress(len, len);
    Ok(mkv)
}

// ------------------------------------------------------------------ constants

/// Read-ahead window bounds for header reads: small after a jump, growing while sequential.
const READ_MIN_WINDOW: usize = 4096;
const READ_MAX_WINDOW: usize = 1 << 20;
/// Progress is reported at most once per this many bytes of file position.
const PROGRESS_STEP: u64 = 1 << 20;
/// Maximum number of simultaneously open containers.
const MAX_DEPTH: usize = 8;
const MAX_TRACKS: usize = 256;
const MAX_STRING: u64 = 64 * 1024;
const MAX_CODEC_PRIVATE: u64 = 1024 * 1024;
const MAX_EBML_HEADER: u64 = 64 * 1024;
/// Largest block header: 8-byte track vint + i16 timecode + flags.
const MAX_BLOCK_HEADER: usize = 8 + 3;
const DEFAULT_TIMECODE_SCALE: u64 = 1_000_000;
const DEFAULT_SAMPLING_FREQUENCY: f64 = 8000.0;
const TRUNCATED_WARNING: &str = "file appears truncated; trailing data ignored";

const ID_EBML: u32 = 0x1A45_DFA3;
const ID_DOCTYPE: u32 = 0x4282;
const ID_SEGMENT: u32 = 0x1853_8067;
const ID_SEEKHEAD: u32 = 0x114D_9B74;
const ID_INFO: u32 = 0x1549_A966;
const ID_TIMECODE_SCALE: u32 = 0x2AD7B1;
const ID_DURATION: u32 = 0x4489;
const ID_TRACKS: u32 = 0x1654_AE6B;
const ID_TRACK_ENTRY: u32 = 0xAE;
const ID_TRACK_NUMBER: u32 = 0xD7;
const ID_TRACK_TYPE: u32 = 0x83;
const ID_CODEC_ID: u32 = 0x86;
const ID_CODEC_PRIVATE: u32 = 0x63A2;
const ID_LANGUAGE: u32 = 0x22B59C;
const ID_DEFAULT_DURATION: u32 = 0x23E383;
const ID_CODEC_DELAY: u32 = 0x56AA;
const ID_SEEK_PRE_ROLL: u32 = 0x56BB;
const ID_CONTENT_ENCODINGS: u32 = 0x6D80;
const ID_VIDEO: u32 = 0xE0;
const ID_PIXEL_WIDTH: u32 = 0xB0;
const ID_PIXEL_HEIGHT: u32 = 0xBA;
const ID_DISPLAY_WIDTH: u32 = 0x54B0;
const ID_DISPLAY_HEIGHT: u32 = 0x54BA;
const ID_AUDIO: u32 = 0xE1;
const ID_SAMPLING_FREQUENCY: u32 = 0xB5;
const ID_OUTPUT_SAMPLING_FREQUENCY: u32 = 0x78B5;
const ID_CHANNELS: u32 = 0x9F;
const ID_BIT_DEPTH: u32 = 0x6264;
const ID_CLUSTER: u32 = 0x1F43_B675;
const ID_TIMECODE: u32 = 0xE7;
const ID_SIMPLE_BLOCK: u32 = 0xA3;
const ID_BLOCK_GROUP: u32 = 0xA0;
const ID_BLOCK: u32 = 0xA1;
const ID_BLOCK_DURATION: u32 = 0x9B;
const ID_REFERENCE_BLOCK: u32 = 0xFB;
const ID_DISCARD_PADDING: u32 = 0x75A2;
const ID_CUES: u32 = 0x1C53_BB6B;
const ID_CHAPTERS: u32 = 0x1043_A770;
const ID_TAGS: u32 = 0x1254_C367;
const ID_ATTACHMENTS: u32 = 0x1941_A469;

// ------------------------------------------------------------------ helpers

fn invalid(msg: impl Into<String>) -> Error {
    Error::InvalidMkv(msg.into())
}

/// Appends to `v`, growing geometrically and mapping allocation failure to `TooLarge`.
fn try_push<T>(v: &mut Vec<T>, x: T) -> Result<()> {
    if v.len() == v.capacity() {
        let extra = v.len().max(16);
        v.try_reserve(extra)
            .map_err(|_| Error::TooLarge("sample index allocation failed".into()))?;
    }
    v.push(x);
    Ok(())
}

/// Reads one element header at `pos`, never past `limit`.
/// `Ok(None)` means the header is cut off by `limit` (truncation).
fn read_header<B: Source>(src: &mut B, pos: u64, limit: u64) -> Result<Option<Header>> {
    let avail = limit.saturating_sub(pos);
    if avail == 0 {
        return Ok(None);
    }
    let n = avail.min(MAX_HEADER_LEN as u64) as usize;
    let mut buf = [0u8; MAX_HEADER_LEN];
    let dst = buf
        .get_mut(..n)
        .ok_or_else(|| Error::Io("header buffer".into()))?;
    src.read_at(pos, dst)?;
    ebml::parse_header(dst)
}

/// Reads `size` bytes at `offset` after checking `size <= cap` (no allocation beyond the cap).
fn read_bounded<B: Source>(
    src: &mut B,
    offset: u64,
    size: u64,
    cap: u64,
    what: &str,
) -> Result<Vec<u8>> {
    if size > cap {
        return Err(Error::TooLarge(format!(
            "{what} element is {size} bytes (limit {cap})"
        )));
    }
    let len =
        usize::try_from(size).map_err(|_| Error::TooLarge(format!("{what} element too large")))?;
    let mut buf = Vec::new();
    buf.try_reserve_exact(len)
        .map_err(|_| Error::TooLarge(format!("{what} allocation failed")))?;
    buf.resize(len, 0);
    if len > 0 {
        src.read_at(offset, &mut buf)?;
    }
    Ok(buf)
}

/// Trims trailing NUL bytes and decodes UTF-8 leniently.
fn text(bytes: &[u8]) -> String {
    let end = bytes.iter().rposition(|b| *b != 0).map_or(0, |p| p + 1);
    String::from_utf8_lossy(bytes.get(..end).unwrap_or_default()).into_owned()
}

fn read_string<B: Source>(src: &mut B, data: u64, size: u64) -> Result<String> {
    let bytes = read_bounded(src, data, size, MAX_STRING, "string")?;
    Ok(text(&bytes))
}

fn read_uint<B: Source>(src: &mut B, data: u64, size: u64) -> Result<u64> {
    if size > 8 {
        return Err(invalid("integer element longer than 8 bytes"));
    }
    let bytes = read_bounded(src, data, size, 8, "integer")?;
    ebml::uint_value(&bytes)
}

fn read_sint<B: Source>(src: &mut B, data: u64, size: u64) -> Result<i64> {
    if size > 8 {
        return Err(invalid("signed integer element longer than 8 bytes"));
    }
    let bytes = read_bounded(src, data, size, 8, "signed integer")?;
    ebml::sint_value(&bytes)
}

/// Float element; zero-length means absent (`None`).
fn read_float_opt<B: Source>(src: &mut B, data: u64, size: u64) -> Result<Option<f64>> {
    match size {
        0 => Ok(None),
        4 | 8 => {
            let bytes = read_bounded(src, data, size, 8, "float")?;
            Ok(Some(ebml::float_value(&bytes)?))
        }
        _ => Err(invalid("float element must be 4 or 8 bytes")),
    }
}

fn u32_of(v: u64, what: &str) -> Result<u32> {
    u32::try_from(v).map_err(|_| invalid(format!("{what} out of range")))
}

fn is_container(id: u32) -> bool {
    matches!(
        id,
        ID_SEGMENT
            | ID_INFO
            | ID_TRACKS
            | ID_TRACK_ENTRY
            | ID_VIDEO
            | ID_AUDIO
            | ID_CLUSTER
            | ID_BLOCK_GROUP
    )
}

/// Level-1 IDs: children of Segment. They end an unknown-size Cluster.
fn is_level1(id: u32) -> bool {
    matches!(
        id,
        ID_SEEKHEAD
            | ID_INFO
            | ID_TRACKS
            | ID_CLUSTER
            | ID_CUES
            | ID_CHAPTERS
            | ID_TAGS
            | ID_ATTACHMENTS
    )
}

/// Whether element `id` ends an open unknown-size container of type `open_id`.
fn ends_unknown(open_id: u32, id: u32) -> bool {
    id == ID_EBML || id == ID_SEGMENT || is_level1(id) || id == open_id
}

/// Reads the EBML header at file start and returns its end offset.
fn read_ebml_header<B: Source>(src: &mut B, len: u64) -> Result<u64> {
    let not_mkv = || Error::InvalidMkv("not a Matroska/WebM file".into());
    let hdr = read_header(src, 0, len)?.ok_or_else(not_mkv)?;
    if hdr.id != ID_EBML {
        return Err(not_mkv());
    }
    let size = hdr
        .size
        .ok_or_else(|| invalid("EBML header has unknown size"))?;
    let body_start = hdr.len as u64;
    let end = body_start
        .checked_add(size)
        .ok_or_else(|| invalid("EBML header size overflows"))?;
    if end > len {
        return Err(invalid("truncated EBML header"));
    }
    let body = read_bounded(src, body_start, size, MAX_EBML_HEADER, "EBML header")?;
    match doc_type(&body)? {
        Some(t) if t == "matroska" || t == "webm" => Ok(end),
        _ => Err(not_mkv()),
    }
}

/// Finds the DocType child of an in-memory EBML header body.
fn doc_type(body: &[u8]) -> Result<Option<String>> {
    let mut pos = 0usize;
    while let Some(rest) = body.get(pos..) {
        let Some(hdr) = ebml::parse_header(rest)? else {
            break;
        };
        let Some(size) = hdr.size.and_then(|s| usize::try_from(s).ok()) else {
            break;
        };
        let start = pos + hdr.len;
        let Some(stop) = start.checked_add(size) else {
            break;
        };
        let Some(data) = body.get(start..stop) else {
            break;
        };
        if hdr.id == ID_DOCTYPE {
            return Ok(Some(text(data)));
        }
        pos = stop;
    }
    Ok(None)
}

// ------------------------------------------------------------------ scanner state

/// An open container on the explicit parse stack.
struct Open {
    id: u32,
    /// Declared end (clamped to the parent limit when cut); `None` = unknown size.
    end: Option<u64>,
    /// Upper bound for children: `end`, or the parent's bound when unknown.
    limit: u64,
    group: GroupState,
}

/// Pending state of a BlockGroup; the sample is committed only when the group closes.
#[derive(Default)]
struct GroupState {
    block: Option<BlockRef>,
    duration_units: Option<u64>,
    has_reference: bool,
    discard_ns: Option<i64>,
}

/// A parsed, non-laced block whose track is known.
#[derive(Clone, Copy)]
struct BlockRef {
    track: usize,
    offset: u64,
    size: u32,
    pts_ns: i64,
    /// SimpleBlock keyframe flag (ignored for BlockGroup members).
    keyframe: bool,
}

/// TrackEntry under construction.
struct Draft {
    number: Option<u64>,
    codec_id: Option<String>,
    track: MkvTrack,
}

impl Draft {
    fn new() -> Self {
        Draft {
            number: None,
            codec_id: None,
            track: MkvTrack {
                number: 0,
                kind: TrackKind::Other,
                codec_id: String::new(),
                codec_private: Vec::new(),
                language: "und".into(),
                default_duration_ns: None,
                codec_delay_ns: None,
                seek_pre_roll_ns: None,
                video: None,
                audio: None,
                laced: false,
                content_encoded: false,
                samples: Vec::new(),
            },
        }
    }
}

struct Scanner {
    max_samples: usize,
    total_samples: usize,
    timecode_scale: u64,
    duration_units: Option<f64>,
    tracks: Vec<MkvTrack>,
    track_index: HashMap<u64, usize>,
    draft: Option<Draft>,
    cluster_tc: u64,
    seen_segment: bool,
    stack: Vec<Open>,
    warnings: Vec<String>,
}

impl Scanner {
    fn new(max_samples: usize) -> Self {
        Scanner {
            max_samples,
            total_samples: 0,
            timecode_scale: DEFAULT_TIMECODE_SCALE,
            duration_units: None,
            tracks: Vec::new(),
            track_index: HashMap::new(),
            draft: None,
            cluster_tc: 0,
            seen_segment: false,
            stack: Vec::new(),
            warnings: Vec::new(),
        }
    }

    /// Walks the whole file. Returns `true` when the file was truncated.
    fn run<B: Source>(&mut self, src: &mut B, progress: &mut dyn FnMut(u64, u64)) -> Result<bool> {
        let len = src.len();
        let mut pos = read_ebml_header(src, len)?;
        let mut reported = 0u64;
        let mut truncated = false;
        loop {
            self.close_exhausted(pos)?;
            if self.stack.is_empty() && pos >= len {
                break;
            }
            if pos.saturating_sub(reported) >= PROGRESS_STEP {
                progress(pos, len);
                reported = pos;
            }
            let limit = self.stack.last().map_or(len, |t| t.limit);
            let parent = self.stack.last().map_or(0, |t| t.id);
            let Some(hdr) = read_header(src, pos, limit)? else {
                truncated = true;
                break;
            };
            if self.ends_open_unknown(hdr.id) {
                self.close_top()?;
                continue;
            }
            if self.seen_segment && matches!(hdr.id, ID_EBML | ID_SEGMENT) {
                self.warnings.push("additional segments ignored".into());
                break;
            }
            let data = pos
                .checked_add(hdr.len as u64)
                .ok_or_else(|| invalid("element offset overflows"))?;
            let Some(size) = hdr.size else {
                if is_container(hdr.id) {
                    self.open(hdr.id, None, limit)?;
                    pos = data;
                    continue;
                }
                return Err(invalid(format!("element 0x{:X} has unknown size", hdr.id)));
            };
            let declared_end = data
                .checked_add(size)
                .ok_or_else(|| invalid("element size overflows"))?;
            if is_container(hdr.id) {
                // A container cut by EOF or its parent keeps its complete children.
                if declared_end > limit {
                    truncated = true;
                }
                self.open(hdr.id, Some(declared_end.min(limit)), limit)?;
                pos = data;
                continue;
            }
            if declared_end > limit {
                // A leaf cut by EOF or its parent is dropped.
                truncated = true;
                break;
            }
            self.leaf(src, parent, hdr.id, data, size)?;
            pos = declared_end;
        }
        self.finalize_draft()?;
        Ok(truncated)
    }

    fn into_mkv(self, truncated: bool) -> Result<Mkv> {
        if !self.seen_segment {
            return Err(invalid("no Segment element found"));
        }
        if self.tracks.is_empty() {
            return Err(invalid("no tracks found"));
        }
        let mut warnings = self.warnings;
        if truncated {
            warnings.push(TRUNCATED_WARNING.into());
        }
        let scale = self.timecode_scale;
        let duration_ns = self
            .duration_units
            .filter(|d| d.is_finite() && *d >= 0.0)
            .map(|d| (d * scale as f64) as u64);
        Ok(Mkv {
            timecode_scale_ns: scale,
            duration_ns,
            tracks: self.tracks,
            warnings,
        })
    }

    /// Pops every container whose extent ends at `pos`.
    fn close_exhausted(&mut self, pos: u64) -> Result<()> {
        while let Some(top) = self.stack.last() {
            let exhausted = match top.end {
                Some(end) => pos >= end,
                None => pos >= top.limit,
            };
            if !exhausted {
                break;
            }
            self.close_top()?;
        }
        Ok(())
    }

    /// True when the innermost open container has unknown size and `id` terminates it.
    fn ends_open_unknown(&self, id: u32) -> bool {
        match self.stack.last() {
            Some(top) if top.end.is_none() && top.id != ID_SEGMENT => ends_unknown(top.id, id),
            _ => false,
        }
    }

    fn open(&mut self, id: u32, end: Option<u64>, parent_limit: u64) -> Result<()> {
        if self.stack.len() >= MAX_DEPTH {
            return Err(invalid("EBML nesting too deep"));
        }
        match id {
            ID_SEGMENT => self.seen_segment = true,
            ID_TRACK_ENTRY => {
                self.finalize_draft()?;
                self.draft = Some(Draft::new());
            }
            ID_VIDEO => {
                if let Some(t) = self.draft_track() {
                    t.video = Some(VideoInfo {
                        pixel_width: 0,
                        pixel_height: 0,
                        display_width: None,
                        display_height: None,
                    });
                }
            }
            ID_AUDIO => {
                if let Some(t) = self.draft_track() {
                    t.audio = Some(AudioInfo {
                        sampling_frequency: DEFAULT_SAMPLING_FREQUENCY,
                        output_sampling_frequency: None,
                        channels: 1,
                        bit_depth: None,
                    });
                }
            }
            ID_CLUSTER => self.cluster_tc = 0,
            _ => {}
        }
        let limit = end.unwrap_or(parent_limit);
        self.stack.push(Open {
            id,
            end,
            limit,
            group: GroupState::default(),
        });
        Ok(())
    }

    fn close_top(&mut self) -> Result<()> {
        let Some(top) = self.stack.pop() else {
            return Ok(());
        };
        match top.id {
            ID_BLOCK_GROUP => self.commit_group(top.group),
            ID_TRACK_ENTRY => self.finalize_draft(),
            _ => Ok(()),
        }
    }

    fn draft_track(&mut self) -> Option<&mut MkvTrack> {
        self.draft.as_mut().map(|d| &mut d.track)
    }

    fn group_mut(&mut self) -> Option<&mut GroupState> {
        self.stack.last_mut().map(|t| &mut t.group)
    }

    /// Moves the current TrackEntry into `tracks`; drops it with a warning if incomplete.
    fn finalize_draft(&mut self) -> Result<()> {
        let Some(draft) = self.draft.take() else {
            return Ok(());
        };
        let Draft {
            number,
            codec_id,
            mut track,
        } = draft;
        let (Some(number), Some(codec_id)) = (number, codec_id) else {
            self.warnings
                .push("track entry without TrackNumber or CodecID ignored".into());
            return Ok(());
        };
        if self.tracks.len() >= MAX_TRACKS {
            return Err(Error::TooLarge(format!("more than {MAX_TRACKS} tracks")));
        }
        track.number = number;
        track.codec_id = codec_id;
        self.track_index.entry(number).or_insert(self.tracks.len());
        self.tracks.push(track);
        Ok(())
    }

    fn commit_group(&mut self, group: GroupState) -> Result<()> {
        let Some(b) = group.block else {
            return Ok(());
        };
        let duration_ns = match group.duration_units {
            Some(units) => Some(
                units
                    .checked_mul(self.timecode_scale)
                    .ok_or_else(|| invalid("block duration overflows"))?,
            ),
            None => None,
        };
        let sample = SampleRef {
            offset: b.offset,
            size: b.size,
            pts_ns: b.pts_ns,
            keyframe: !group.has_reference,
            duration_ns,
            discard_padding_ns: group.discard_ns,
        };
        self.push_sample(b.track, sample)
    }

    fn push_sample(&mut self, track: usize, sample: SampleRef) -> Result<()> {
        if self.total_samples >= self.max_samples {
            return Err(Error::TooLarge(format!(
                "more than {} samples",
                self.max_samples
            )));
        }
        let Some(t) = self.tracks.get_mut(track) else {
            return Ok(());
        };
        self.total_samples += 1;
        try_push(&mut t.samples, sample)
    }

    /// Parses a Block/SimpleBlock header. Returns `None` for unknown tracks and laced
    /// blocks (laced blocks mark their track). Payload bytes are never read.
    fn read_block<B: Source>(
        &mut self,
        src: &mut B,
        data: u64,
        size: u64,
    ) -> Result<Option<BlockRef>> {
        let n = size.min(MAX_BLOCK_HEADER as u64) as usize;
        let mut buf = [0u8; MAX_BLOCK_HEADER];
        let head = buf
            .get_mut(..n)
            .ok_or_else(|| Error::Io("block header buffer".into()))?;
        src.read_at(data, head)?;
        let head: &[u8] = head;
        let vint = ebml::parse_vint(head)?.ok_or_else(|| invalid("block header truncated"))?;
        let fixed: [u8; 3] = head
            .get(vint.len..vint.len + 3)
            .and_then(|s| <[u8; 3]>::try_from(s).ok())
            .ok_or_else(|| invalid("block header larger than its element"))?;
        let [r0, r1, flags] = fixed;
        let Some(&track) = self.track_index.get(&vint.value) else {
            return Ok(None);
        };
        if flags & 0x06 != 0 {
            if let Some(t) = self.tracks.get_mut(track) {
                t.laced = true;
            }
            return Ok(None);
        }
        let hdr = (vint.len + 3) as u64;
        let payload = size
            .checked_sub(hdr)
            .ok_or_else(|| invalid("block header larger than its element"))?;
        let size32 = u32::try_from(payload)
            .map_err(|_| Error::TooLarge("block payload larger than 4 GiB".into()))?;
        let offset = data
            .checked_add(hdr)
            .ok_or_else(|| invalid("block offset overflows"))?;
        let units = i128::from(self.cluster_tc) + i128::from(i16::from_be_bytes([r0, r1]));
        let pts_ns = units
            .checked_mul(i128::from(self.timecode_scale))
            .and_then(|v| i64::try_from(v).ok())
            .ok_or_else(|| invalid("block timestamp overflows"))?;
        Ok(Some(BlockRef {
            track,
            offset,
            size: size32,
            pts_ns,
            keyframe: flags & 0x80 != 0,
        }))
    }

    /// Dispatches a non-container element. Unknown elements are skipped by size.
    fn leaf<B: Source>(
        &mut self,
        src: &mut B,
        parent: u32,
        id: u32,
        data: u64,
        size: u64,
    ) -> Result<()> {
        match parent {
            ID_INFO => self.info_leaf(src, id, data, size),
            ID_TRACK_ENTRY => self.track_leaf(src, id, data, size),
            ID_VIDEO => self.video_leaf(src, id, data, size),
            ID_AUDIO => self.audio_leaf(src, id, data, size),
            ID_CLUSTER => self.cluster_leaf(src, id, data, size),
            ID_BLOCK_GROUP => self.group_leaf(src, id, data, size),
            _ => Ok(()),
        }
    }

    fn info_leaf<B: Source>(&mut self, src: &mut B, id: u32, data: u64, size: u64) -> Result<()> {
        match id {
            ID_TIMECODE_SCALE => {
                let v = read_uint(src, data, size)?;
                if v == 0 {
                    return Err(invalid("TimecodeScale is zero"));
                }
                self.timecode_scale = v;
            }
            ID_DURATION => {
                if let Some(v) = read_float_opt(src, data, size)? {
                    self.duration_units = Some(v);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn track_leaf<B: Source>(&mut self, src: &mut B, id: u32, data: u64, size: u64) -> Result<()> {
        match id {
            ID_TRACK_NUMBER => {
                let v = read_uint(src, data, size)?;
                if let Some(d) = self.draft.as_mut() {
                    d.number = Some(v);
                }
            }
            ID_CODEC_ID => {
                let v = read_string(src, data, size)?;
                if let Some(d) = self.draft.as_mut() {
                    d.codec_id = Some(v);
                }
            }
            ID_TRACK_TYPE => {
                let v = read_uint(src, data, size)?;
                if let Some(t) = self.draft_track() {
                    t.kind = match v {
                        1 => TrackKind::Video,
                        2 => TrackKind::Audio,
                        _ => TrackKind::Other,
                    };
                }
            }
            ID_CODEC_PRIVATE => {
                let v = read_bounded(src, data, size, MAX_CODEC_PRIVATE, "CodecPrivate")?;
                if let Some(t) = self.draft_track() {
                    t.codec_private = v;
                }
            }
            ID_LANGUAGE => {
                let v = read_string(src, data, size)?;
                if let Some(t) = self.draft_track() {
                    t.language = if v.is_empty() { "und".into() } else { v };
                }
            }
            ID_DEFAULT_DURATION => {
                let v = read_uint(src, data, size)?;
                if let Some(t) = self.draft_track() {
                    t.default_duration_ns = Some(v);
                }
            }
            ID_CODEC_DELAY => {
                let v = read_uint(src, data, size)?;
                if let Some(t) = self.draft_track() {
                    t.codec_delay_ns = Some(v);
                }
            }
            ID_SEEK_PRE_ROLL => {
                let v = read_uint(src, data, size)?;
                if let Some(t) = self.draft_track() {
                    t.seek_pre_roll_ns = Some(v);
                }
            }
            ID_CONTENT_ENCODINGS => {
                if let Some(t) = self.draft_track() {
                    t.content_encoded = true;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn video_leaf<B: Source>(&mut self, src: &mut B, id: u32, data: u64, size: u64) -> Result<()> {
        if !matches!(
            id,
            ID_PIXEL_WIDTH | ID_PIXEL_HEIGHT | ID_DISPLAY_WIDTH | ID_DISPLAY_HEIGHT
        ) {
            return Ok(());
        }
        let v = u32_of(read_uint(src, data, size)?, "video dimension")?;
        let Some(video) = self.draft.as_mut().and_then(|d| d.track.video.as_mut()) else {
            return Ok(());
        };
        match id {
            ID_PIXEL_WIDTH => video.pixel_width = v,
            ID_PIXEL_HEIGHT => video.pixel_height = v,
            ID_DISPLAY_WIDTH => video.display_width = Some(v),
            _ => video.display_height = Some(v),
        }
        Ok(())
    }

    fn audio_leaf<B: Source>(&mut self, src: &mut B, id: u32, data: u64, size: u64) -> Result<()> {
        match id {
            ID_SAMPLING_FREQUENCY | ID_OUTPUT_SAMPLING_FREQUENCY => {
                let Some(f) = read_float_opt(src, data, size)? else {
                    return Ok(());
                };
                if let Some(audio) = self.draft.as_mut().and_then(|d| d.track.audio.as_mut()) {
                    if id == ID_SAMPLING_FREQUENCY {
                        audio.sampling_frequency = f;
                    } else {
                        audio.output_sampling_frequency = Some(f);
                    }
                }
            }
            ID_CHANNELS => {
                let v = u32_of(read_uint(src, data, size)?, "channel count")?;
                if let Some(audio) = self.draft.as_mut().and_then(|d| d.track.audio.as_mut()) {
                    audio.channels = v;
                }
            }
            ID_BIT_DEPTH => {
                let v = u32_of(read_uint(src, data, size)?, "bit depth")?;
                if let Some(audio) = self.draft.as_mut().and_then(|d| d.track.audio.as_mut()) {
                    audio.bit_depth = Some(v);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn cluster_leaf<B: Source>(
        &mut self,
        src: &mut B,
        id: u32,
        data: u64,
        size: u64,
    ) -> Result<()> {
        match id {
            ID_TIMECODE => self.cluster_tc = read_uint(src, data, size)?,
            ID_SIMPLE_BLOCK => {
                if let Some(b) = self.read_block(src, data, size)? {
                    let sample = SampleRef {
                        offset: b.offset,
                        size: b.size,
                        pts_ns: b.pts_ns,
                        keyframe: b.keyframe,
                        duration_ns: None,
                        discard_padding_ns: None,
                    };
                    self.push_sample(b.track, sample)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn group_leaf<B: Source>(&mut self, src: &mut B, id: u32, data: u64, size: u64) -> Result<()> {
        match id {
            ID_BLOCK => {
                let block = self.read_block(src, data, size)?;
                if let Some(g) = self.group_mut() {
                    g.block = block;
                }
            }
            ID_BLOCK_DURATION => {
                let v = read_uint(src, data, size)?;
                if let Some(g) = self.group_mut() {
                    g.duration_units = Some(v);
                }
            }
            ID_REFERENCE_BLOCK => {
                if let Some(g) = self.group_mut() {
                    g.has_reference = true;
                }
            }
            ID_DISCARD_PADDING => {
                let v = read_sint(src, data, size)?;
                if let Some(g) = self.group_mut() {
                    g.discard_ns = Some(v);
                }
            }
            _ => {}
        }
        Ok(())
    }
}

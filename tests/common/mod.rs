//! Test-only helpers: a synthetic Matroska BUILDER and an independent MP4 PARSER.
//! These are the authoritative spec for the crate's behaviour (DESIGN.md Rev 4).
#![allow(dead_code)]

use mkv2mp4::source::SliceSource;
use mkv2mp4::{convert::convert, convert::ConvertOptions, convert::ConvertReport, error::Result};

// ---------------------------------------------------------------- EBML writer
pub fn id_bytes(id: u32) -> Vec<u8> {
    let b = id.to_be_bytes();
    let skip = b.iter().take_while(|x| **x == 0).count();
    b[skip..].to_vec()
}
pub fn size_vint(n: u64) -> Vec<u8> {
    for len in 1..=8usize {
        if n < (1u64 << (7 * len)) - 1 {
            let v = n | (1u64 << (7 * len));
            return v.to_be_bytes()[8 - len..].to_vec();
        }
    }
    panic!("size too large")
}
pub fn elem(id: u32, payload: &[u8]) -> Vec<u8> {
    let mut v = id_bytes(id);
    v.extend(size_vint(payload.len() as u64));
    v.extend_from_slice(payload);
    v
}
pub fn elem_unknown(id: u32, payload: &[u8]) -> Vec<u8> {
    let mut v = id_bytes(id);
    v.extend([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    v.extend_from_slice(payload);
    v
}
pub fn uint_el(id: u32, v: u64) -> Vec<u8> {
    let b = v.to_be_bytes();
    let skip = b.iter().take_while(|x| **x == 0).count().min(7);
    elem(id, &b[skip..])
}
pub fn sint_el(id: u32, v: i64) -> Vec<u8> {
    elem(id, &v.to_be_bytes())
}
pub fn float_el(id: u32, v: f64) -> Vec<u8> {
    elem(id, &v.to_be_bytes())
}
pub fn str_el(id: u32, s: &str) -> Vec<u8> {
    elem(id, s.as_bytes())
}

// ---------------------------------------------------------------- MKV builder
#[derive(Clone)]
pub struct TrackSpec {
    pub number: u64,
    pub kind: u8, // 1 video, 2 audio, 17 subtitle
    pub codec_id: String,
    pub codec_private: Vec<u8>,
    pub language: Option<String>,
    pub default_duration_ns: Option<u64>,
    pub video: Option<(u32, u32, Option<(u32, u32)>)>, // pixel w,h, display w,h
    pub audio: Option<(f64, u32, Option<f64>)>,        // freq, channels, output freq
    pub codec_delay_ns: Option<u64>,
    pub content_encoding: bool,
}
impl TrackSpec {
    pub fn video(number: u64, codec_id: &str, private: Vec<u8>, w: u32, h: u32) -> Self {
        TrackSpec {
            number,
            kind: 1,
            codec_id: codec_id.into(),
            codec_private: private,
            language: None,
            default_duration_ns: None,
            video: Some((w, h, None)),
            audio: None,
            codec_delay_ns: None,
            content_encoding: false,
        }
    }
    pub fn audio(number: u64, codec_id: &str, private: Vec<u8>, freq: f64, ch: u32) -> Self {
        TrackSpec {
            number,
            kind: 2,
            codec_id: codec_id.into(),
            codec_private: private,
            language: Some("eng".into()),
            default_duration_ns: None,
            video: None,
            audio: Some((freq, ch, None)),
            codec_delay_ns: None,
            content_encoding: false,
        }
    }
}

#[derive(Clone)]
pub struct Frame {
    pub track: u64,
    pub pts_ms: i64,
    pub data: Vec<u8>,
    pub key: bool,
    pub group: bool, // write as BlockGroup (key => no ReferenceBlock)
    pub duration_ms: Option<u64>,
    pub lace: bool,
    pub discard_padding_ns: Option<i64>,
}
impl Frame {
    pub fn new(track: u64, pts_ms: i64, data: Vec<u8>, key: bool) -> Self {
        Frame {
            track,
            pts_ms,
            data,
            key,
            group: false,
            duration_ms: None,
            lace: false,
            discard_padding_ns: None,
        }
    }
}

#[derive(Clone)]
pub struct MkvOpts {
    pub unknown_segment: bool,
    pub unknown_clusters: bool,
    pub void_and_crc: bool,
    pub timecode_scale: u64,
    pub frames_per_cluster: usize,
    pub duration_ms: f64,
}
impl Default for MkvOpts {
    fn default() -> Self {
        MkvOpts {
            unknown_segment: false,
            unknown_clusters: false,
            void_and_crc: false,
            timecode_scale: 1_000_000,
            frames_per_cluster: 8,
            duration_ms: 1000.0,
        }
    }
}

pub fn track_entry(t: &TrackSpec) -> Vec<u8> {
    let mut e = Vec::new();
    e.extend(uint_el(0xD7, t.number));
    e.extend(uint_el(0x73C5, t.number + 1000));
    e.extend(uint_el(0x83, t.kind as u64));
    e.extend(str_el(0x86, &t.codec_id));
    if !t.codec_private.is_empty() {
        e.extend(elem(0x63A2, &t.codec_private));
    }
    if let Some(l) = &t.language {
        e.extend(str_el(0x22B59C, l));
    }
    if let Some(d) = t.default_duration_ns {
        e.extend(uint_el(0x23E383, d));
    }
    if let Some(d) = t.codec_delay_ns {
        e.extend(uint_el(0x56AA, d));
    }
    if let Some((w, h, disp)) = t.video {
        let mut v = Vec::new();
        v.extend(uint_el(0xB0, w as u64));
        v.extend(uint_el(0xBA, h as u64));
        if let Some((dw, dh)) = disp {
            v.extend(uint_el(0x54B0, dw as u64));
            v.extend(uint_el(0x54BA, dh as u64));
        }
        e.extend(elem(0xE0, &v));
    }
    if let Some((f, ch, of)) = t.audio {
        let mut a = Vec::new();
        a.extend(float_el(0xB5, f));
        if let Some(o) = of {
            a.extend(float_el(0x78B5, o));
        }
        a.extend(uint_el(0x9F, ch as u64));
        e.extend(elem(0xE1, &a));
    }
    if t.content_encoding {
        e.extend(elem(0x6D80, &elem(0x6240, &uint_el(0x5031, 0))));
    }
    elem(0xAE, &e)
}

fn block_bytes(f: &Frame, cluster_tc_ms: i64, scale: u64) -> Vec<u8> {
    let rel = ((f.pts_ms - cluster_tc_ms) * 1_000_000 / scale as i64) as i16;
    let mut b = vec![0x80 | f.track as u8];
    b.extend(rel.to_be_bytes());
    let mut flags = if f.group {
        0
    } else if f.key {
        0x80
    } else {
        0
    };
    if f.lace {
        flags |= 0x02;
    }
    b.push(flags);
    b.extend_from_slice(&f.data);
    b
}

pub fn build_mkv(tracks: &[TrackSpec], frames: &[Frame], o: &MkvOpts) -> Vec<u8> {
    let ebml = elem(
        0x1A45DFA3,
        &[uint_el(0x4286, 1), str_el(0x4282, "matroska")].concat(),
    );
    let scale = o.timecode_scale;
    let info = elem(
        0x1549A966,
        &[
            uint_el(0x2AD7B1, scale),
            float_el(0x4489, o.duration_ms * 1e6 / scale as f64),
        ]
        .concat(),
    );
    let tr = elem(
        0x1654AE6B,
        &tracks.iter().flat_map(track_entry).collect::<Vec<_>>(),
    );
    let mut seg = Vec::new();
    if o.void_and_crc {
        seg.extend(elem(0xEC, &[0u8; 5]));
    }
    seg.extend(info);
    seg.extend(tr);
    for chunk in frames.chunks(o.frames_per_cluster.max(1)) {
        let ctc = chunk[0].pts_ms;
        let mut c = Vec::new();
        if o.void_and_crc {
            c.extend(elem(0xBF, &[1, 2, 3, 4]));
            c.extend(elem(0xEC, &[0u8; 3]));
        }
        c.extend(uint_el(0xE7, (ctc * 1_000_000 / scale as i64) as u64));
        for f in chunk {
            let blk = block_bytes(f, ctc, scale);
            if f.group {
                let mut g = elem(0xA1, &blk);
                if let Some(d) = f.duration_ms {
                    g.extend(uint_el(0x9B, d * 1_000_000 / scale));
                }
                if !f.key {
                    g.extend(sint_el(0xFB, -1));
                }
                if let Some(p) = f.discard_padding_ns {
                    g.extend(sint_el(0x75A2, p));
                }
                c.extend(elem(0xA0, &g));
            } else {
                c.extend(elem(0xA3, &blk));
            }
            if o.void_and_crc {
                c.extend(elem(0xEC, &[0u8; 2]));
            }
        }
        seg.extend(if o.unknown_clusters {
            elem_unknown(0x1F43B675, &c)
        } else {
            elem(0x1F43B675, &c)
        });
    }
    let mut out = ebml;
    out.extend(if o.unknown_segment {
        elem_unknown(0x18538067, &seg)
    } else {
        elem(0x18538067, &seg)
    });
    out
}

/// Deterministic unique payload.
pub fn payload(tag: u8, i: usize, len: usize) -> Vec<u8> {
    (0..len)
        .map(|k| tag.wrapping_mul(31).wrapping_add((i * 7 + k) as u8))
        .collect()
}

// ---- codec-private builders
pub const AVCC: [u8; 15] = [1, 66, 0, 30, 0xFF, 0xE1, 0, 4, 0x67, 1, 2, 3, 1, 0, 0];
pub const ASC_LC_48K_STEREO: [u8; 2] = [0x11, 0x90];

/// hvcC with given arrays: (complete, nal_type, nal bytes). lengthSizeMinusOne = 3.
pub fn hvcc(arrays: &[(bool, u8, Vec<u8>)]) -> Vec<u8> {
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
pub fn hevc_nal(typ: u8, body: &[u8]) -> Vec<u8> {
    let mut n = vec![typ << 1, 0x01];
    n.extend_from_slice(body);
    let mut v = (n.len() as u32).to_be_bytes().to_vec();
    v.extend(n);
    v
}
pub fn hvcc_complete() -> Vec<u8> {
    hvcc(&[
        (true, 32, vec![0x40, 1, 1]),
        (true, 33, vec![0x42, 1, 1]),
        (true, 34, vec![0x44, 1, 1]),
    ])
}
pub fn opus_head(
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
pub fn flac_private(min_bs: u16, max_bs: u16) -> Vec<u8> {
    let mut v = b"fLaC".to_vec();
    v.extend([0x80, 0, 0, 34]);
    v.extend(min_bs.to_be_bytes());
    v.extend(max_bs.to_be_bytes());
    v.extend([0u8; 6]); // min/max frame size
    v.extend([0x0A, 0xC4, 0x42, 0xF0, 0, 0, 0, 0]); // 44100 Hz, 2ch, 16bps, total samples 0
    v.extend([0u8; 16]);
    assert_eq!(v.len(), 42);
    v
}
/// FLAC frame: header with blocksize code (7 => 16-bit explicit size, 12 => 4096) + filler.
pub fn flac_frame(block_size: u32, filler: usize) -> Vec<u8> {
    let mut v = vec![0xFF, 0xF8];
    match block_size {
        4096 => {
            v.push(0xC9);
            v.push(0x18);
            v.push(0x00); // frame number (1 byte utf8)
        }
        n => {
            v.push(0x79);
            v.push(0x18);
            v.push(0x00);
            v.extend(((n - 1) as u16).to_be_bytes());
        }
    }
    v.push(0x00); // crc8
    v.extend(vec![0xAB; filler]);
    v
}
pub fn ac3_frame() -> Vec<u8> {
    let mut v = vec![0x0B, 0x77, 0, 0, 0x0A, 0x40, 0xE1];
    v.extend(vec![0x55; 40]);
    v
}

// ---------------------------------------------------------------- convert helpers
pub fn run_convert(mkv: &[u8]) -> Result<(Vec<u8>, ConvertReport)> {
    let mut out = Vec::new();
    let r = convert(
        SliceSource(mkv),
        &mut out,
        &ConvertOptions::default(),
        &mut |_| {},
    )?;
    Ok((out, r))
}
pub fn ok_convert(mkv: &[u8]) -> (Mp4, ConvertReport) {
    let (out, r) = run_convert(mkv).expect("convert failed");
    assert_eq!(
        out.len() as u64,
        r.output_size,
        "report.output_size must equal bytes written"
    );
    (Mp4::parse(out), r)
}

// ---------------------------------------------------------------- MP4 parser
#[derive(Debug, Clone)]
pub struct BoxRef {
    pub typ: String,
    pub start: usize,
    pub payload: usize,
    pub end: usize,
}
pub fn be16(d: &[u8], p: usize) -> u16 {
    u16::from_be_bytes(d[p..p + 2].try_into().unwrap())
}
pub fn be32(d: &[u8], p: usize) -> u32 {
    u32::from_be_bytes(d[p..p + 4].try_into().unwrap())
}
pub fn be64(d: &[u8], p: usize) -> u64 {
    u64::from_be_bytes(d[p..p + 8].try_into().unwrap())
}
pub fn parse_boxes(d: &[u8], mut pos: usize, end: usize) -> Vec<BoxRef> {
    let mut v = Vec::new();
    while pos < end {
        assert!(pos + 8 <= end, "truncated box header at {pos}");
        let mut size = be32(d, pos) as usize;
        let typ = String::from_utf8_lossy(&d[pos + 4..pos + 8]).to_string();
        let mut hdr = 8;
        if size == 1 {
            size = be64(d, pos + 8) as usize;
            hdr = 16;
        } else if size == 0 {
            size = end - pos;
        }
        assert!(
            size >= hdr && pos + size <= end,
            "bad box {typ} size {size} at {pos} (end {end})"
        );
        v.push(BoxRef {
            typ,
            start: pos,
            payload: pos + hdr,
            end: pos + size,
        });
        pos += size;
    }
    v
}
pub fn find<'a>(v: &'a [BoxRef], t: &str) -> Option<&'a BoxRef> {
    v.iter().find(|b| b.typ == t)
}
pub fn children(d: &[u8], b: &BoxRef) -> Vec<BoxRef> {
    parse_boxes(d, b.payload, b.end)
}

#[derive(Debug, Clone)]
pub struct TrackInfo {
    pub id: u32,
    pub handler: String,
    pub timescale: u32,
    pub media_duration: u64,
    pub tkhd_duration: u64,
    pub width: f64,
    pub height: f64,
    pub volume: u16,
    pub language: String,
    pub edits: Vec<(u64, i64)>,
    pub entry_type: String,
    pub entry: BoxRef,
    pub stts: Vec<(u32, u32)>,
    pub ctts: Option<Vec<(u32, u32)>>,
    pub stss: Option<Vec<u32>>,
    pub stsc: Vec<(u32, u32, u32)>,
    pub sizes: Vec<u32>,
    pub chunk_offsets: Vec<u64>,
    pub co64: bool,
}
impl TrackInfo {
    pub fn durations(&self) -> Vec<u32> {
        self.stts
            .iter()
            .flat_map(|(n, d)| std::iter::repeat(*d).take(*n as usize))
            .collect()
    }
    pub fn dts(&self) -> Vec<u64> {
        let mut t = 0u64;
        self.durations()
            .into_iter()
            .map(|d| {
                let c = t;
                t += d as u64;
                c
            })
            .collect()
    }
    pub fn cts_offsets(&self) -> Vec<u32> {
        match &self.ctts {
            None => vec![0; self.sizes.len()],
            Some(c) => c
                .iter()
                .flat_map(|(n, o)| std::iter::repeat(*o).take(*n as usize))
                .collect(),
        }
    }
    /// (offset, size) of every sample, expanded through stsc/stco.
    pub fn sample_ranges(&self) -> Vec<(u64, u32)> {
        let mut out = Vec::new();
        let mut si = 0usize;
        for (ci, off) in self.chunk_offsets.iter().enumerate() {
            let chunk_no = ci as u32 + 1;
            let run = self
                .stsc
                .iter()
                .rev()
                .find(|(first, _, _)| *first <= chunk_no)
                .expect("stsc");
            let mut o = *off;
            for _ in 0..run.1 {
                let s = self.sizes[si];
                out.push((o, s));
                o += s as u64;
                si += 1;
            }
        }
        assert_eq!(si, self.sizes.len(), "stsc/stco do not cover all samples");
        out
    }
    pub fn samples(&self, data: &[u8]) -> Vec<Vec<u8>> {
        self.sample_ranges()
            .iter()
            .map(|(o, s)| data[*o as usize..*o as usize + *s as usize].to_vec())
            .collect()
    }
    /// Presentation time of each sample in ms, honouring the edit list (movie timescale = 1000).
    pub fn presentation_ms(&self) -> Vec<f64> {
        let mut empty = 0u64;
        let mut media_time = 0i64;
        for (seg, mt) in &self.edits {
            if *mt < 0 {
                empty += seg;
            } else {
                media_time = *mt;
                break;
            }
        }
        let cts = self.cts_offsets();
        self.dts()
            .iter()
            .zip(cts)
            .map(|(d, c)| {
                ((*d as i64 + c as i64 - media_time) as f64) * 1000.0 / self.timescale as f64
                    + empty as f64
            })
            .collect()
    }
    /// child box payload of the sample entry (after the fixed audio/video header)
    pub fn entry_child(&self, d: &[u8], typ: &str, fixed_hdr: usize) -> Option<Vec<u8>> {
        let kids = parse_boxes(d, self.entry.payload + fixed_hdr, self.entry.end);
        find(&kids, typ).map(|b| d[b.payload..b.end].to_vec())
    }
}

#[derive(Debug)]
pub struct Mp4 {
    pub data: Vec<u8>,
    pub top: Vec<BoxRef>,
    pub movie_timescale: u32,
    pub movie_duration: u64,
    pub tracks: Vec<TrackInfo>,
}
impl Mp4 {
    pub fn top_types(&self) -> Vec<String> {
        self.top.iter().map(|b| b.typ.clone()).collect()
    }
    pub fn parse(data: Vec<u8>) -> Mp4 {
        let top = parse_boxes(&data, 0, data.len());
        let moov = find(&top, "moov").expect("moov").clone();
        Self::parse_moov(data, top, &moov)
    }
    /// Parse a header-only buffer (ftyp+moov+mdat header, payload absent): last 8/16 bytes are the mdat header.
    pub fn parse_header_only(data: Vec<u8>) -> Mp4 {
        let ftyp_len = be32(&data, 0) as usize;
        let moov_len = be32(&data, ftyp_len) as usize;
        let top = parse_boxes(&data, 0, ftyp_len + moov_len);
        let moov = find(&top, "moov").expect("moov").clone();
        Self::parse_moov(data, top, &moov)
    }
    fn parse_moov(data: Vec<u8>, top: Vec<BoxRef>, moov: &BoxRef) -> Mp4 {
        let mk = children(&data, moov);
        let mvhd = find(&mk, "mvhd").expect("mvhd");
        assert_eq!(data[mvhd.payload], 0, "test parser expects mvhd v0");
        let movie_timescale = be32(&data, mvhd.payload + 12);
        let movie_duration = be32(&data, mvhd.payload + 16) as u64;
        let mut tracks = Vec::new();
        for trak in mk.iter().filter(|b| b.typ == "trak") {
            tracks.push(Self::parse_trak(&data, trak));
        }
        Mp4 {
            data,
            top,
            movie_timescale,
            movie_duration,
            tracks,
        }
    }
    fn parse_trak(d: &[u8], trak: &BoxRef) -> TrackInfo {
        let tk = children(d, trak);
        let tkhd = find(&tk, "tkhd").expect("tkhd");
        let v = d[tkhd.payload];
        let (id, dur, rest) = if v == 0 {
            (
                be32(d, tkhd.payload + 12),
                be32(d, tkhd.payload + 20) as u64,
                tkhd.payload + 24,
            )
        } else {
            (
                be32(d, tkhd.payload + 20),
                be64(d, tkhd.payload + 28),
                tkhd.payload + 36,
            )
        };
        let volume = be16(d, rest + 8 + 4 + 0);
        let wpos = rest + 8 + 2 + 2 + 2 + 2 + 36;
        let width = be32(d, wpos) as f64 / 65536.0;
        let height = be32(d, wpos + 4) as f64 / 65536.0;
        assert_eq!(tkhd.end, wpos + 8, "tkhd size");
        let mut edits = Vec::new();
        if let Some(edts) = find(&tk, "edts") {
            let ek = children(d, edts);
            let elst = find(&ek, "elst").expect("elst");
            let ver = d[elst.payload];
            let n = be32(d, elst.payload + 4) as usize;
            let mut p = elst.payload + 8;
            for _ in 0..n {
                if ver == 0 {
                    edits.push((be32(d, p) as u64, be32(d, p + 4) as i32 as i64));
                    p += 12;
                } else {
                    edits.push((be64(d, p), be64(d, p + 8) as i64));
                    p += 20;
                }
            }
            assert_eq!(p, elst.end, "elst size");
        }
        let mdia = find(&tk, "mdia").expect("mdia");
        let mk = children(d, mdia);
        let mdhd = find(&mk, "mdhd").expect("mdhd");
        let (ts, md, lp) = if d[mdhd.payload] == 0 {
            (
                be32(d, mdhd.payload + 12),
                be32(d, mdhd.payload + 16) as u64,
                mdhd.payload + 20,
            )
        } else {
            (
                be32(d, mdhd.payload + 20),
                be64(d, mdhd.payload + 24),
                mdhd.payload + 32,
            )
        };
        let l = be16(d, lp);
        let language: String = [(l >> 10) & 31, (l >> 5) & 31, l & 31]
            .iter()
            .map(|c| (*c as u8 + 0x60) as char)
            .collect();
        let hdlr = find(&mk, "hdlr").expect("hdlr");
        let handler = String::from_utf8_lossy(&d[hdlr.payload + 8..hdlr.payload + 12]).to_string();
        let minf = find(&mk, "minf").expect("minf");
        let mi = children(d, minf);
        let stbl = find(&mi, "stbl").expect("stbl");
        let sb = children(d, stbl);
        let stsd = find(&sb, "stsd").expect("stsd");
        assert_eq!(be32(d, stsd.payload + 4), 1, "one sample entry");
        let entries = parse_boxes(d, stsd.payload + 8, stsd.end);
        assert_eq!(entries.len(), 1);
        let entry = entries[0].clone();
        let rd = |b: &BoxRef| -> Vec<(u32, u32)> {
            let n = be32(d, b.payload + 4) as usize;
            assert_eq!(b.end, b.payload + 8 + n * 8, "{} size", b.typ);
            (0..n)
                .map(|i| {
                    (
                        be32(d, b.payload + 8 + i * 8),
                        be32(d, b.payload + 12 + i * 8),
                    )
                })
                .collect()
        };
        let stts = rd(find(&sb, "stts").expect("stts"));
        let ctts = find(&sb, "ctts").map(|b| {
            assert_eq!(d[b.payload], 0, "ctts must be v0 (unsigned offsets)");
            rd(b)
        });
        let stss = find(&sb, "stss").map(|b| {
            let n = be32(d, b.payload + 4) as usize;
            (0..n)
                .map(|i| be32(d, b.payload + 8 + i * 4))
                .collect::<Vec<_>>()
        });
        let stsc_b = find(&sb, "stsc").expect("stsc");
        let n = be32(d, stsc_b.payload + 4) as usize;
        let stsc = (0..n)
            .map(|i| {
                let p = stsc_b.payload + 8 + i * 12;
                (be32(d, p), be32(d, p + 4), be32(d, p + 8))
            })
            .collect();
        let stsz = find(&sb, "stsz").expect("stsz");
        assert_eq!(be32(d, stsz.payload + 4), 0, "stsz sample_size must be 0");
        let n = be32(d, stsz.payload + 8) as usize;
        let sizes = (0..n).map(|i| be32(d, stsz.payload + 12 + i * 4)).collect();
        let (chunk_offsets, co64) = if let Some(c) = find(&sb, "stco") {
            let n = be32(d, c.payload + 4) as usize;
            (
                (0..n)
                    .map(|i| be32(d, c.payload + 8 + i * 4) as u64)
                    .collect(),
                false,
            )
        } else {
            let c = find(&sb, "co64").expect("stco or co64");
            let n = be32(d, c.payload + 4) as usize;
            (
                (0..n).map(|i| be64(d, c.payload + 8 + i * 8)).collect(),
                true,
            )
        };
        TrackInfo {
            id,
            handler,
            timescale: ts,
            media_duration: md,
            tkhd_duration: dur,
            width,
            height,
            volume,
            language,
            edits,
            entry_type: entry.typ.clone(),
            entry,
            stts,
            ctts,
            stss,
            stsc,
            sizes,
            chunk_offsets,
            co64,
        }
    }
}

/// Parse MPEG-4 descriptors: returns (tag, payload_start, payload_end) for each descriptor in [pos,end); lengths must be exact.
pub fn parse_descriptors(d: &[u8], mut pos: usize, end: usize) -> Vec<(u8, usize, usize)> {
    let mut v = Vec::new();
    while pos < end {
        let tag = d[pos];
        pos += 1;
        let mut len = 0usize;
        loop {
            let b = d[pos];
            pos += 1;
            len = (len << 7) | (b & 0x7F) as usize;
            if b & 0x80 == 0 {
                break;
            }
        }
        assert!(pos + len <= end, "descriptor overruns parent");
        v.push((tag, pos, pos + len));
        pos += len;
    }
    assert_eq!(pos, end);
    v
}

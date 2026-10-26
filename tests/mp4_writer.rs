mod common;
use common::*;
use mkv2mp4::error::Error;
use mkv2mp4::mkv::TrackKind;
use mkv2mp4::mp4::{build_header, build_moov, write_mp4};
use mkv2mp4::plan::{Chunk, Edit, Plan, PlanSample, PlanTrack};
use mkv2mp4::source::{Sink, Source};

fn avc1_entry() -> Vec<u8> {
    let mut e = vec![0u8; 8 + 78];
    e[4..8].copy_from_slice(b"avc1");
    e[8 + 7] = 1; // data_ref_index
    e[8 + 24..8 + 26].copy_from_slice(&320u16.to_be_bytes());
    e[8 + 26..8 + 28].copy_from_slice(&240u16.to_be_bytes());
    e.extend((8 + AVCC.len() as u32).to_be_bytes());
    e.extend(b"avcC");
    e.extend(AVCC);
    let n = e.len() as u32;
    e[0..4].copy_from_slice(&n.to_be_bytes());
    e
}

/// A one-video-track plan; `chunks_of` lists the sample counts per chunk; sample i has size sizes[i], located consecutively in the source.
fn crafted_plan(sizes: &[u32], chunks_of: &[usize]) -> Plan {
    let mut samples = Vec::new();
    let mut off = 0u64;
    for (i, s) in sizes.iter().enumerate() {
        samples.push(PlanSample {
            offset: off,
            size: *s,
            dts: i as u64 * 3600,
            duration: 3600,
            cts_offset: 0,
            keyframe: i == 0,
        });
        off += *s as u64;
    }
    let mut chunks = Vec::new();
    let (mut first, mut rel) = (0usize, 0u64);
    for c in chunks_of {
        chunks.push(Chunk {
            track: 0,
            first_sample: first,
            sample_count: *c,
            rel_offset: rel,
        });
        rel += sizes[first..first + c]
            .iter()
            .map(|s| *s as u64)
            .sum::<u64>();
        first += c;
    }
    assert_eq!(first, sizes.len());
    let track = PlanTrack {
        track_id: 1,
        kind: TrackKind::Video,
        codec_name: "h264".into(),
        language: "und".into(),
        timescale: 90000,
        media_duration: sizes.len() as u64 * 3600,
        width: 320,
        height: 240,
        channels: 0,
        sample_rate: 0,
        sample_entry: avc1_entry(),
        samples,
        edits: vec![Edit {
            segment_duration: sizes.len() as u64 * 40,
            media_time: 0,
        }],
    };
    Plan {
        movie_timescale: 1000,
        duration: sizes.len() as u64 * 40,
        tracks: vec![track],
        chunks,
        mdat_payload_size: rel,
        warnings: vec![],
    }
}

struct GenSource {
    len: u64,
    max_read: usize,
    reads: usize,
}
fn gen_byte(k: u64) -> u8 {
    ((k * 7) % 251) as u8
}
impl Source for GenSource {
    fn len(&self) -> u64 {
        self.len
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> mkv2mp4::error::Result<()> {
        if offset + buf.len() as u64 > self.len {
            return Err(Error::Io("out of range".into()));
        }
        self.max_read = self.max_read.max(buf.len());
        self.reads += 1;
        for (i, b) in buf.iter_mut().enumerate() {
            *b = gen_byte(offset + i as u64);
        }
        Ok(())
    }
}
struct Collect {
    data: Vec<u8>,
    max_write: usize,
}
impl Sink for Collect {
    fn write(&mut self, d: &[u8]) -> mkv2mp4::error::Result<()> {
        self.max_write = self.max_write.max(d.len());
        self.data.extend_from_slice(d);
        Ok(())
    }
}
struct CountOnly {
    total: u64,
}
impl Sink for CountOnly {
    fn write(&mut self, d: &[u8]) -> mkv2mp4::error::Result<()> {
        self.total += d.len() as u64;
        Ok(())
    }
}

#[test]
fn write_mp4_matches_header_plus_payload_and_parses() {
    let sizes = [10u32, 20, 30];
    let plan = crafted_plan(&sizes, &[2, 1]);
    let mut src = GenSource {
        len: 60,
        max_read: 0,
        reads: 0,
    };
    let mut sink = Collect {
        data: vec![],
        max_write: 0,
    };
    let mut prog: Vec<(u64, u64)> = vec![];
    let n = write_mp4(&plan, &mut src, &mut sink, &mut |a, b| prog.push((a, b))).unwrap();
    assert_eq!(n as usize, sink.data.len());
    let hdr = build_header(&plan).unwrap();
    assert!(!hdr.co64);
    assert_eq!(hdr.total_size, n);
    assert_eq!(&sink.data[..hdr.bytes.len()], &hdr.bytes[..]);
    assert_eq!(sink.data.len() as u64, hdr.bytes.len() as u64 + 60);
    let mp4 = Mp4::parse(sink.data.clone());
    assert_eq!(mp4.top_types(), vec!["ftyp", "moov", "mdat"]);
    let t = &mp4.tracks[0];
    assert_eq!(t.sizes, vec![10, 20, 30]);
    assert_eq!(t.stsc.len(), 2, "run-length stsc: 2 samples/chunk then 1");
    let expect: Vec<Vec<u8>> = [(0u64, 10usize), (10, 20), (30, 30)]
        .iter()
        .map(|(o, l)| (0..*l as u64).map(|k| gen_byte(o + k)).collect())
        .collect();
    assert_eq!(t.samples(&mp4.data), expect);
    assert_eq!(t.stss, Some(vec![1]));
    assert!(prog.windows(2).all(|w| w[0].0 <= w[1].0));
    assert_eq!(*prog.last().unwrap(), (60, 60));
}

#[test]
fn moov_length_is_independent_of_offset_and_stco_overflow_is_an_error() {
    let plan = crafted_plan(&[10, 20, 30], &[1, 1, 1]);
    let a = build_moov(&plan, 0, false).unwrap();
    let b = build_moov(&plan, 123_456, false).unwrap();
    assert_eq!(a.len(), b.len());
    let c = build_moov(&plan, 0, true).unwrap();
    assert_eq!(c.len(), a.len() + 3 * 4, "co64 grows by 4 bytes per chunk");
    assert!(matches!(
        build_moov(&plan, u32::MAX as u64, false),
        Err(Error::TooLarge(_))
    ));
    assert!(build_moov(&plan, u32::MAX as u64 + 1, true).is_ok());
}

#[test]
fn header_uses_co64_for_payload_over_4gib_without_reading_data() {
    let gib2 = 2u32 << 30;
    let plan = crafted_plan(&[gib2, gib2, gib2], &[1, 1, 1]);
    assert_eq!(plan.mdat_payload_size, 6u64 << 30);
    let h = build_header(&plan).unwrap();
    assert!(h.co64);
    let n = h.bytes.len();
    assert_eq!(
        &h.bytes[n - 16..n - 8],
        &[0, 0, 0, 1, b'm', b'd', b'a', b't'],
        "64-bit mdat header"
    );
    assert_eq!(be64(&h.bytes, n - 8), 16 + (6u64 << 30));
    assert_eq!(h.total_size, n as u64 + (6u64 << 30));
    let mp4 = Mp4::parse_header_only(h.bytes.clone());
    let t = &mp4.tracks[0];
    assert!(t.co64);
    assert_eq!(
        t.chunk_offsets,
        vec![n as u64, n as u64 + (2u64 << 30), n as u64 + (4u64 << 30)]
    );
}

#[test]
fn header_uses_co64_when_the_end_of_file_crosses_4gib_even_if_chunk_starts_do_not() {
    // two samples: every chunk START is below u32::MAX but ftyp+moov+mdat header+payload exceeds it
    let payload = u32::MAX as u64 - 100;
    let s1 = (1u64 << 31) - 1;
    let s2 = payload - s1;
    let plan = crafted_plan(&[s1 as u32, s2 as u32], &[1, 1]);
    assert_eq!(plan.mdat_payload_size, payload);
    let h = build_header(&plan).unwrap();
    assert!(h.co64, "conservative end-of-file bound selects co64");
    let n = h.bytes.len();
    assert_eq!(
        be32(&h.bytes, n - 8),
        (8 + payload) as u32,
        "payload+8 still fits a 32-bit mdat size"
    );
    let mp4 = Mp4::parse_header_only(h.bytes.clone());
    assert_eq!(mp4.tracks[0].chunk_offsets, vec![(n as u64), n as u64 + s1]);
    // and just below the bound stco is used
    let small = build_header(&crafted_plan(&[1000, 2000], &[1, 1])).unwrap();
    assert!(!small.co64);
}

#[test]
fn huge_sample_is_copied_in_slices_of_at_most_1mib() {
    let size = 3 * 1024 * 1024 + 17;
    let plan = crafted_plan(&[size], &[1]);
    let mut src = GenSource {
        len: size as u64,
        max_read: 0,
        reads: 0,
    };
    let mut sink = Collect {
        data: vec![],
        max_write: 0,
    };
    write_mp4(&plan, &mut src, &mut sink, &mut |_, _| {}).unwrap();
    assert!(src.max_read <= 1 << 20, "max single read {}", src.max_read);
    assert!(src.reads >= 4);
    assert!(
        sink.max_write <= 2 << 20,
        "max single write {}",
        sink.max_write
    );
    let hdr = build_header(&plan).unwrap();
    let body = &sink.data[hdr.bytes.len()..];
    assert_eq!(body.len(), size as usize);
    assert!(body
        .iter()
        .enumerate()
        .all(|(k, b)| *b == gen_byte(k as u64)));
}

#[test]
fn many_small_samples_are_batched_into_few_sink_writes() {
    let sizes = vec![100u32; 20_000]; // 2 MB total
    let plan = crafted_plan(&sizes, &[20_000]);
    let mut src = GenSource {
        len: 2_000_000,
        max_read: 0,
        reads: 0,
    };
    struct Writes(usize);
    impl Sink for Writes {
        fn write(&mut self, _: &[u8]) -> mkv2mp4::error::Result<()> {
            self.0 += 1;
            Ok(())
        }
    }
    let mut w = Writes(0);
    write_mp4(&plan, &mut src, &mut w, &mut |_, _| {}).unwrap();
    assert!(
        w.0 <= 8,
        "sink writes must be batched (~1 MiB staging), got {}",
        w.0
    );
}

#[test]
fn out_of_range_source_reads_are_errors_not_panics() {
    let plan = crafted_plan(&[10, 20], &[2]);
    let mut src = GenSource {
        len: 15,
        max_read: 0,
        reads: 0,
    };
    let mut sink = CountOnly { total: 0 };
    let r = write_mp4(&plan, &mut src, &mut sink, &mut |_, _| {});
    assert!(matches!(r, Err(Error::Io(_))), "{r:?}");
}

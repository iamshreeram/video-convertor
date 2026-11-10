//! Regression tests for "invalid Matroska file: invalid EBML element ID" on real-world files.
//!
//! Users reported a large, valid MKV being rejected mid-scan. The scanner used to abort the whole
//! file on the first byte that is not a valid element ID (for example a zero-filled tail of a
//! preallocated or partially downloaded recording, or a damaged region between clusters). Readers
//! such as ffmpeg and mkvtoolnix instead *resync* to the next Cluster and keep everything that was
//! readable. These tests pin that behaviour and the diagnostics of the remaining hard failures.

mod common;
use common::*;
use mkv2mp4::convert::{convert, ConvertOptions};
use mkv2mp4::error::Error;
use mkv2mp4::mkv::{scan, Mkv};
use mkv2mp4::source::{BufferedSource, SliceSource, Source};

const CLUSTER_ID: [u8; 4] = [0x1F, 0x43, 0xB6, 0x75];

fn vtrack() -> TrackSpec {
    let mut t = TrackSpec::video(1, "V_MPEG4/ISO/AVC", AVCC.to_vec(), 320, 240);
    t.default_duration_ns = Some(40_000_000);
    t
}

/// 30 video frames, one keyframe per cluster of 10.
fn frames() -> Vec<Frame> {
    (0..30usize)
        .map(|i| Frame::new(1, i as i64 * 40, payload(1, i, 400), i % 10 == 0))
        .collect()
}

fn opts(unknown_segment: bool, unknown_clusters: bool) -> MkvOpts {
    MkvOpts {
        unknown_segment,
        unknown_clusters,
        frames_per_cluster: 10,
        ..Default::default()
    }
}

fn clean(o: &MkvOpts) -> Vec<u8> {
    build_mkv(&[vtrack()], &frames(), o)
}

fn do_scan(bytes: &[u8]) -> Result<Mkv, Error> {
    scan(&mut SliceSource(bytes), &mut |_, _| {})
}

fn sample_count(m: &Mkv) -> usize {
    m.tracks[0].samples.len()
}

fn cluster_positions(bytes: &[u8]) -> Vec<usize> {
    (0..bytes.len().saturating_sub(4))
        .filter(|&i| bytes[i..i + 4] == CLUSTER_ID)
        .collect()
}

fn has_warning(m: &Mkv, needle: &str) -> bool {
    m.warnings.iter().any(|w| w.contains(needle))
}

// ---------------------------------------------------------------- H1: zero / garbage tails

#[test]
fn zero_filled_tail_after_finite_segment_is_ignored() {
    let mut bytes = clean(&opts(false, false));
    bytes.extend(std::iter::repeat(0u8).take(64 * 1024));
    let m = do_scan(&bytes).expect("zero tail must not make a valid file unreadable");
    assert_eq!(sample_count(&m), 30);
    assert!(
        has_warning(&m, "ignored"),
        "a warning must tell the user trailing data was ignored: {:?}",
        m.warnings
    );
}

#[test]
fn zero_filled_tail_with_unknown_size_segment_and_clusters_is_ignored() {
    let mut bytes = clean(&opts(true, true));
    bytes.extend(std::iter::repeat(0u8).take(1 << 20));
    let m = do_scan(&bytes).expect("zero tail after live-style file");
    assert_eq!(sample_count(&m), 30);
    assert!(has_warning(&m, "ignored"), "{:?}", m.warnings);
}

#[test]
fn garbage_tail_is_ignored() {
    let mut bytes = clean(&opts(true, false));
    // Bytes whose lead byte is not a valid ID start (0x00) and runs of 0xFF / noise.
    bytes.extend(std::iter::repeat(0xFFu8).take(777));
    bytes.extend((0..4096u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8));
    let m = do_scan(&bytes).expect("garbage tail");
    assert_eq!(sample_count(&m), 30);
    assert!(has_warning(&m, "ignored"), "{:?}", m.warnings);
}

#[test]
fn zero_tail_convert_output_is_identical_to_clean_file() {
    let o = opts(false, false);
    let good = clean(&o);
    let mut padded = good.clone();
    padded.extend(std::iter::repeat(0u8).take(32 * 1024));
    let run = |b: &[u8]| {
        let mut out: Vec<u8> = Vec::new();
        convert(
            SliceSource(b),
            &mut out,
            &ConvertOptions::default(),
            &mut |_| {},
        )
        .expect("convert");
        out
    };
    assert_eq!(
        run(&good),
        run(&padded),
        "padding after the data must not change the MP4"
    );
}

// ---------------------------------------------------------------- resync after damage

#[test]
fn junk_between_clusters_is_skipped_and_later_clusters_are_kept() {
    // unknown-size segment so inserting bytes does not make the Segment size wrong
    let bytes = clean(&opts(true, false));
    let pos = cluster_positions(&bytes);
    assert_eq!(pos.len(), 3, "fixture has 3 clusters");
    let mut damaged = bytes[..pos[1]].to_vec();
    damaged.extend(std::iter::repeat(0u8).take(333)); // invalid ID lead byte
    damaged.extend([0xFFu8; 17]);
    damaged.extend_from_slice(&bytes[pos[1]..]);
    let m = do_scan(&damaged).expect("junk between clusters");
    assert_eq!(
        sample_count(&m),
        30,
        "all three clusters are still readable"
    );
    assert!(has_warning(&m, "skipped"), "{:?}", m.warnings);
}

#[test]
fn damaged_cluster_body_loses_only_that_cluster() {
    let bytes = clean(&opts(true, false));
    let pos = cluster_positions(&bytes);
    // Overwrite the middle of the 2nd cluster with 0x00 (keeps every size field of the
    // surrounding elements intact; the block headers inside become undecodable).
    let mut damaged = bytes.clone();
    let (a, b) = (pos[1] + 40, pos[2] - 40);
    for x in &mut damaged[a..b] {
        *x = 0;
    }
    let m = do_scan(&damaged).expect("damaged cluster body");
    let n = sample_count(&m);
    assert!(
        (19..=30).contains(&n) && n >= 20,
        "clusters 1 and 3 must survive, got {n}"
    );
    assert!(
        m.tracks[0].samples.iter().any(|s| s.offset > pos[2] as u64),
        "samples after the damage must be present"
    );
    assert!(has_warning(&m, "skipped"), "{:?}", m.warnings);
}

#[test]
fn convert_survives_damage_and_reports_it() {
    let bytes = clean(&opts(true, false));
    let pos = cluster_positions(&bytes);
    let mut damaged = bytes[..pos[1]].to_vec();
    damaged.extend(std::iter::repeat(0u8).take(500));
    damaged.extend_from_slice(&bytes[pos[1]..]);
    let mut out: Vec<u8> = Vec::new();
    let report = convert(
        SliceSource(&damaged),
        &mut out,
        &ConvertOptions::default(),
        &mut |_| {},
    )
    .expect("convert with junk between clusters");
    assert!(!out.is_empty());
    assert!(
        report.warnings.iter().any(|w| w.contains("skipped")),
        "{:?}",
        report.warnings
    );
}

// ---------------------------------------------------------------- hard failures stay actionable

#[test]
fn unreadable_data_before_any_cluster_reports_offset_and_bytes() {
    // EBML header + Segment(unknown size) + Info + Tracks, then zeros and no cluster at all.
    let bytes = clean(&opts(true, false));
    let first_cluster = cluster_positions(&bytes)[0];
    let mut broken = bytes[..first_cluster].to_vec();
    broken.extend(std::iter::repeat(0u8).take(256));
    let err = do_scan(&broken).expect_err("no media data at all must still be an error");
    let msg = err.to_string();
    assert!(
        msg.contains("offset") && msg.contains("00 00 00 00"),
        "diagnostic must name the offset and show the first bytes, got: {msg}"
    );
}

#[test]
fn not_an_mkv_still_gives_the_not_mkv_error() {
    let err = do_scan(&[0u8; 100]).expect_err("zeros are not an MKV");
    assert!(matches!(err, Error::InvalidMkv(_)), "{err:?}");
}

// ---------------------------------------------------------------- H3/H4: offsets above 4 GiB

/// Virtual file: `head` + `gap` zero bytes (inside a Void element) + `tail`. No big allocation.
struct BigSource {
    head: Vec<u8>,
    gap: u64,
    tail: Vec<u8>,
}
impl Source for BigSource {
    fn len(&self) -> u64 {
        self.head.len() as u64 + self.gap + self.tail.len() as u64
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> mkv2mp4::error::Result<()> {
        let end = offset + buf.len() as u64;
        if end > self.len() {
            return Err(Error::Io("read past end".into()));
        }
        let head_len = self.head.len() as u64;
        let tail_start = head_len + self.gap;
        for (i, b) in buf.iter_mut().enumerate() {
            let p = offset + i as u64;
            *b = if p < head_len {
                self.head[p as usize]
            } else if p < tail_start {
                0
            } else {
                self.tail[(p - tail_start) as usize]
            };
        }
        Ok(())
    }
}

#[test]
fn cluster_data_beyond_4_gib_scans_and_converts() {
    let bytes = clean(&opts(true, false));
    let first_cluster = cluster_positions(&bytes)[0];
    let gap: u64 = (5u64 << 30) + 12345; // ~5 GiB of Void payload
                                         // Void element: id 0xEC, 8-byte size vint (0x01 + 7 bytes), payload = gap zero bytes
    let mut head = bytes[..first_cluster].to_vec();
    head.push(0xEC);
    head.push(0x01);
    head.extend_from_slice(&gap.to_be_bytes()[1..]);
    let tail = bytes[first_cluster..].to_vec();
    let expected_first = head.len() as u64 + gap;
    let make = || BigSource {
        head: head.clone(),
        gap,
        tail: tail.clone(),
    };

    // direct and through the same adaptive window used by the real convert path
    let m = scan(&mut make(), &mut |_, _| {}).expect("scan > 4 GiB file");
    assert_eq!(sample_count(&m), 30);
    assert!(m.tracks[0].samples[0].offset >= expected_first);
    assert!(m.tracks[0].samples[0].offset > u64::from(u32::MAX));

    let mut buffered = BufferedSource::new_adaptive(make(), 64 * 1024, 4 << 20);
    let m2 = scan(&mut buffered, &mut |_, _| {}).expect("scan > 4 GiB file through BufferedSource");
    assert_eq!(sample_count(&m2), 30);

    let mut out: Vec<u8> = Vec::new();
    convert(make(), &mut out, &ConvertOptions::default(), &mut |_| {})
        .expect("convert > 4 GiB file");
    assert!(out.len() > 30 * 400, "all sample payloads copied");
}

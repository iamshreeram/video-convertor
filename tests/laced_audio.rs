//! Matroska lacing: several audio frames packed in one block (Xiph, fixed-size and EBML lacing).
//! Files from some muxers store AAC this way; before lacing support the whole audio track was
//! dropped with "laced blocks are not supported", leaving an MP4 with no sound.

mod common;
use common::*;
use mkv2mp4::mkv::{scan, Mkv};
use mkv2mp4::source::SliceSource;

const AAC_FRAME_NS: i64 = 21_333_333; // 1024 samples at 48 kHz, rounded like the scanner does

fn vtrack() -> TrackSpec {
    TrackSpec::video(1, "V_MPEG4/ISO/AVC", AVCC.to_vec(), 320, 240)
}
fn atrack() -> TrackSpec {
    TrackSpec::audio(2, "A_AAC", ASC_LC_48K_STEREO.to_vec(), 48000.0, 2)
}
fn do_scan(bytes: &[u8]) -> Mkv {
    scan(&mut SliceSource(bytes), &mut |_, _| {}).expect("scan")
}

fn frames_of(sizes: &[usize], tag: u8) -> Vec<Vec<u8>> {
    sizes
        .iter()
        .enumerate()
        .map(|(i, n)| payload(tag, i, *n))
        .collect()
}

fn xiph_block(frames: &[Vec<u8>]) -> Vec<u8> {
    let mut b = vec![(frames.len() - 1) as u8];
    for f in &frames[..frames.len() - 1] {
        let mut n = f.len();
        while n >= 255 {
            b.push(255);
            n -= 255;
        }
        b.push(n as u8);
    }
    for f in frames {
        b.extend_from_slice(f);
    }
    b
}

fn fixed_block(frames: &[Vec<u8>]) -> Vec<u8> {
    let mut b = vec![(frames.len() - 1) as u8];
    for f in frames {
        b.extend_from_slice(f);
    }
    b
}

fn signed_vint(d: i64) -> Vec<u8> {
    for len in 1..=8usize {
        let bias = (1i64 << (7 * len - 1)) - 1;
        if d >= -bias && d <= bias {
            let v = ((d + bias) as u64) | (1u64 << (7 * len));
            return v.to_be_bytes()[8 - len..].to_vec();
        }
    }
    panic!("delta too large")
}

fn ebml_block(frames: &[Vec<u8>]) -> Vec<u8> {
    let mut b = vec![(frames.len() - 1) as u8];
    b.extend(size_vint(frames[0].len() as u64));
    for w in frames[..frames.len() - 1].windows(2) {
        b.extend(signed_vint(w[1].len() as i64 - w[0].len() as i64));
    }
    for f in frames {
        b.extend_from_slice(f);
    }
    b
}

fn laced(pts_ms: i64, kind: u8, data: Vec<u8>) -> Frame {
    let mut f = Frame::new(2, pts_ms, data, true);
    f.lace = true;
    f.lace_kind = kind;
    f
}

/// Two laced audio blocks plus video; returns (mkv, expected audio frames in order).
fn sample_file(kind: u8, first: &[usize], second: &[usize]) -> (Vec<u8>, Vec<Vec<u8>>) {
    let a = frames_of(first, 2);
    let b = frames_of(second, 3);
    let pack = |f: &[Vec<u8>]| match kind {
        1 => xiph_block(f),
        2 => fixed_block(f),
        _ => ebml_block(f),
    };
    let frames = vec![
        Frame::new(1, 0, payload(1, 0, 40), true),
        laced(0, kind, pack(&a)),
        Frame::new(1, 40, payload(1, 1, 30), false),
        laced(64, kind, pack(&b)),
    ];
    let mkv = build_mkv(
        &[vtrack(), atrack()],
        &frames,
        &MkvOpts {
            frames_per_cluster: 4,
            ..Default::default()
        },
    );
    (mkv, [a, b].concat())
}

fn assert_audio(m: &Mkv, bytes: &[u8], expected: &[Vec<u8>], first_block: usize) {
    let t = &m.tracks[1];
    assert!(!t.laced, "a readable lace must not mark the track laced");
    assert_eq!(
        t.samples.len(),
        expected.len(),
        "one sample per laced frame"
    );
    for (s, want) in t.samples.iter().zip(expected) {
        let got = &bytes[s.offset as usize..s.offset as usize + s.size as usize];
        assert_eq!(got, want.as_slice(), "frame bytes");
        assert!(s.keyframe);
    }
    // frames inside a block are spaced by the AAC frame length, starting at the block time
    for i in 0..first_block {
        assert_eq!(
            t.samples[i].pts_ns,
            i as i64 * AAC_FRAME_NS,
            "block 1 frame {i}"
        );
        assert_eq!(t.samples[i].duration_ns, Some(AAC_FRAME_NS as u64));
    }
    for i in first_block..expected.len() {
        let k = (i - first_block) as i64;
        assert_eq!(
            t.samples[i].pts_ns,
            64_000_000 + k * AAC_FRAME_NS,
            "block 2 frame {k}"
        );
    }
}

#[test]
fn xiph_lacing_yields_one_sample_per_frame() {
    // 300 needs a 255 + 45 size field
    let (mkv, expected) = sample_file(1, &[10, 300, 20], &[21, 22, 23]);
    assert_audio(&do_scan(&mkv), &mkv, &expected, 3);
}

#[test]
fn ebml_lacing_with_positive_and_negative_deltas() {
    let (mkv, expected) = sample_file(3, &[100, 130, 90, 90], &[40, 41, 39]);
    assert_audio(&do_scan(&mkv), &mkv, &expected, 4);
}

#[test]
fn fixed_size_lacing_splits_evenly() {
    let (mkv, expected) = sample_file(2, &[50, 50, 50, 50], &[30, 30]);
    assert_audio(&do_scan(&mkv), &mkv, &expected, 4);
}

#[test]
fn a_single_frame_lace_is_valid() {
    let (mkv, expected) = sample_file(1, &[17], &[18]);
    assert_audio(&do_scan(&mkv), &mkv, &expected, 1);
}

#[test]
fn block_duration_sets_the_frame_spacing_in_a_block_group() {
    let a = frames_of(&[20, 21, 22], 2);
    let mut g = laced(0, 1, xiph_block(&a));
    g.group = true;
    g.duration_ms = Some(60); // three frames -> 20 ms each
    let mkv = build_mkv(
        &[vtrack(), atrack()],
        &[Frame::new(1, 0, payload(1, 0, 40), true), g],
        &MkvOpts::default(),
    );
    let m = do_scan(&mkv);
    let pts: Vec<i64> = m.tracks[1].samples.iter().map(|s| s.pts_ns).collect();
    assert_eq!(pts, vec![0, 20_000_000, 40_000_000]);
    assert!(m.tracks[1]
        .samples
        .iter()
        .all(|s| s.duration_ns == Some(20_000_000)));
}

#[test]
fn default_duration_is_used_when_present() {
    let a = frames_of(&[20, 21], 2);
    let mut t = atrack();
    t.default_duration_ns = Some(23_000_000);
    let mkv = build_mkv(
        &[vtrack(), t],
        &[
            Frame::new(1, 0, payload(1, 0, 40), true),
            laced(0, 1, xiph_block(&a)),
        ],
        &MkvOpts::default(),
    );
    let m = do_scan(&mkv);
    let pts: Vec<i64> = m.tracks[1].samples.iter().map(|s| s.pts_ns).collect();
    assert_eq!(pts, vec![0, 23_000_000]);
}

#[test]
fn laced_aac_converts_to_an_mp4_with_every_frame() {
    let (mkv, expected) = sample_file(1, &[10, 300, 20], &[21, 22, 23]);
    let (mp4, report) = ok_convert(&mkv);
    assert!(
        !report.warnings.iter().any(|w| w.contains("laced")),
        "no laced warning: {:?}",
        report.warnings
    );
    let audio = mp4
        .tracks
        .iter()
        .find(|t| t.handler == "soun")
        .expect("audio track written");
    assert_eq!(audio.samples(&mp4.data), expected);
    let total: u64 = audio.durations().iter().map(|d| u64::from(*d)).sum();
    assert!(
        total >= 6 * 1024 - 2,
        "audio duration {total} covers all frames"
    );
}

#[test]
fn unreadable_laces_still_skip_the_track_without_failing_the_file() {
    // lace header claims more bytes than the block holds
    let mut bad = vec![2u8, 200, 200];
    bad.extend(payload(2, 0, 30));
    let mkv = build_mkv(
        &[vtrack(), atrack()],
        &[Frame::new(1, 0, payload(1, 0, 40), true), laced(0, 1, bad)],
        &MkvOpts::default(),
    );
    let m = do_scan(&mkv);
    assert!(m.tracks[1].laced);
    // the file still converts, video only, with the existing warning
    let (mp4, report) = ok_convert(&mkv);
    assert!(mp4.tracks.iter().all(|t| t.handler != "soun"));
    assert!(
        report.warnings.iter().any(|w| w.contains("laced")),
        "{:?}",
        report.warnings
    );
}

#[test]
fn lace_header_truncated_by_the_block_end_is_unreadable() {
    let mkv = build_mkv(
        &[vtrack(), atrack()],
        &[
            Frame::new(1, 0, payload(1, 0, 40), true),
            laced(0, 1, vec![5, 255]), // 6 frames announced, size table cut off
        ],
        &MkvOpts::default(),
    );
    assert!(do_scan(&mkv).tracks[1].laced);
}

#[test]
fn unknown_frame_duration_keeps_the_old_behaviour() {
    // A codec whose frame length is not fixed and no DefaultDuration: timestamps are unknowable.
    let t = TrackSpec::audio(2, "A_FLAC", flac_private(4096, 4096), 48000.0, 2);
    let a = frames_of(&[20, 21], 2);
    let mkv = build_mkv(
        &[vtrack(), t],
        &[
            Frame::new(1, 0, payload(1, 0, 40), true),
            laced(0, 1, xiph_block(&a)),
        ],
        &MkvOpts::default(),
    );
    let m = do_scan(&mkv);
    assert!(m.tracks[1].laced);
}

#[test]
fn laced_video_is_still_unsupported() {
    let mut f = Frame::new(1, 0, xiph_block(&frames_of(&[10, 11], 1)), true);
    f.lace = true;
    let mkv = build_mkv(&[vtrack(), atrack()], &[f], &MkvOpts::default());
    assert!(do_scan(&mkv).tracks[0].laced);
}

#[test]
fn zero_length_frames_are_rejected() {
    let a = vec![vec![], payload(2, 0, 20)];
    let mkv = build_mkv(
        &[vtrack(), atrack()],
        &[
            Frame::new(1, 0, payload(1, 0, 40), true),
            laced(0, 1, xiph_block(&a)),
        ],
        &MkvOpts::default(),
    );
    assert!(do_scan(&mkv).tracks[1].laced);
}

#[test]
fn random_corruption_of_a_laced_file_never_panics() {
    let (mkv, _) = sample_file(3, &[100, 130, 90, 90], &[40, 41, 39]);
    for i in 0..mkv.len() {
        let mut c = mkv.clone();
        c[i] ^= 0xA5;
        let _ = scan(&mut SliceSource(&c), &mut |_, _| {});
    }
}

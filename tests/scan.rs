mod common;
use common::*;
use mkv2mp4::error::Error;
use mkv2mp4::mkv::{scan, scan_with_limits, Limits, Mkv, TrackKind};
use mkv2mp4::source::{BufferedSource, SliceSource, Source};

fn vtrack() -> TrackSpec {
    TrackSpec::video(1, "V_MPEG4/ISO/AVC", AVCC.to_vec(), 320, 240)
}
fn atrack() -> TrackSpec {
    TrackSpec::audio(2, "A_AAC", ASC_LC_48K_STEREO.to_vec(), 48000.0, 2)
}
fn do_scan(bytes: &[u8]) -> Result<Mkv, Error> {
    scan(&mut SliceSource(bytes), &mut |_, _| {})
}
fn some_frames() -> Vec<Frame> {
    vec![
        Frame::new(1, 0, payload(1, 0, 50), true),
        Frame::new(2, 0, payload(2, 0, 20), true),
        Frame::new(1, 42, payload(1, 1, 30), false),
        Frame::new(2, 21, payload(2, 1, 21), true),
        Frame::new(1, 83, payload(1, 2, 31), false),
        Frame::new(2, 43, payload(2, 2, 22), true),
    ]
}

#[test]
fn basic_scan_records_tracks_and_samples() {
    let frames = some_frames();
    let mut vt = vtrack();
    vt.video = Some((320, 240, Some((640, 480))));
    vt.default_duration_ns = Some(41_666_667);
    let bytes = build_mkv(
        &[vt, atrack()],
        &frames,
        &MkvOpts {
            frames_per_cluster: 4,
            ..Default::default()
        },
    );
    let m = do_scan(&bytes).unwrap();
    assert_eq!(m.timecode_scale_ns, 1_000_000);
    assert!(m.duration_ns.is_some());
    assert_eq!(m.tracks.len(), 2);
    let v = &m.tracks[0];
    assert_eq!((v.number, v.kind), (1, TrackKind::Video));
    assert_eq!(v.codec_id, "V_MPEG4/ISO/AVC");
    assert_eq!(v.codec_private, AVCC.to_vec());
    assert_eq!(v.language, "und");
    assert_eq!(v.default_duration_ns, Some(41_666_667));
    let vi = v.video.as_ref().unwrap();
    assert_eq!(
        (
            vi.pixel_width,
            vi.pixel_height,
            vi.display_width,
            vi.display_height
        ),
        (320, 240, Some(640), Some(480))
    );
    let a = &m.tracks[1];
    assert_eq!(a.kind, TrackKind::Audio);
    assert_eq!(a.language, "eng");
    let ai = a.audio.as_ref().unwrap();
    assert_eq!(
        (
            ai.sampling_frequency,
            ai.channels,
            ai.output_sampling_frequency
        ),
        (48000.0, 2, None)
    );
    // samples reference the exact payload bytes, in file order, with pts in ns
    for (t, tn) in [(v, 1u64), (a, 2u64)] {
        let fs: Vec<&Frame> = frames.iter().filter(|f| f.track == tn).collect();
        assert_eq!(t.samples.len(), fs.len());
        for (s, f) in t.samples.iter().zip(fs) {
            assert_eq!(
                &bytes[s.offset as usize..s.offset as usize + s.size as usize],
                &f.data[..]
            );
            assert_eq!(s.pts_ns, f.pts_ms * 1_000_000);
            assert_eq!(s.keyframe, f.key);
        }
    }
    assert!(m.warnings.is_empty(), "{:?}", m.warnings);
}

#[test]
fn custom_timecode_scale_and_negative_relative_timecodes() {
    // scale 500_000 ns; B-frame style negative relative timecodes (cluster tc = first frame, later frames earlier)
    let frames = vec![
        Frame::new(1, 100, payload(1, 0, 10), true),
        Frame::new(1, 160, payload(1, 1, 10), false),
        Frame::new(1, 120, payload(1, 2, 10), false),
        Frame::new(1, 140, payload(1, 3, 10), false),
    ];
    let bytes = build_mkv(
        &[vtrack()],
        &frames,
        &MkvOpts {
            timecode_scale: 500_000,
            frames_per_cluster: 2,
            ..Default::default()
        },
    );
    let m = do_scan(&bytes).unwrap();
    assert_eq!(m.timecode_scale_ns, 500_000);
    let pts: Vec<i64> = m.tracks[0].samples.iter().map(|s| s.pts_ns).collect();
    assert_eq!(
        pts,
        vec![100_000_000, 160_000_000, 120_000_000, 140_000_000]
    );
    // second cluster starts at 120ms, first frame rel 0, second frame rel +20ms; also test a truly negative rel:
    let frames2 = vec![
        Frame::new(1, 100, payload(1, 0, 5), true),
        Frame::new(1, 60, payload(1, 1, 5), false),
    ];
    let b2 = build_mkv(&[vtrack()], &frames2, &MkvOpts::default());
    let pts2: Vec<i64> = do_scan(&b2).unwrap().tracks[0]
        .samples
        .iter()
        .map(|s| s.pts_ns)
        .collect();
    assert_eq!(pts2, vec![100_000_000, 60_000_000]);
}

#[test]
fn block_group_keyframe_duration_and_discard_padding() {
    let mut f0 = Frame::new(1, 0, payload(1, 0, 10), true);
    f0.group = true;
    f0.duration_ms = Some(40);
    let mut f1 = Frame::new(1, 40, payload(1, 1, 10), false);
    f1.group = true; // has ReferenceBlock
    f1.discard_padding_ns = Some(-5);
    let f2 = Frame::new(1, 80, payload(1, 2, 10), false); // SimpleBlock non-key
    let bytes = build_mkv(&[vtrack()], &[f0, f1, f2], &MkvOpts::default());
    let s = &do_scan(&bytes).unwrap().tracks[0].samples;
    assert_eq!(
        s.iter().map(|x| x.keyframe).collect::<Vec<_>>(),
        vec![true, false, false]
    );
    assert_eq!(s[0].duration_ns, Some(40_000_000));
    assert_eq!(s[1].duration_ns, None);
    assert_eq!(s[1].discard_padding_ns, Some(-5));
    assert_eq!(s[0].discard_padding_ns, None);
}

#[test]
fn unknown_size_segment_and_clusters_with_void_and_crc() {
    let frames: Vec<Frame> = (0..12)
        .map(|i| Frame::new(1, i * 40, payload(1, i as usize, 20 + i as usize), i == 0))
        .collect();
    let o = MkvOpts {
        unknown_segment: true,
        unknown_clusters: true,
        void_and_crc: true,
        frames_per_cluster: 3,
        ..Default::default()
    };
    let bytes = build_mkv(&[vtrack()], &frames, &o);
    let m = do_scan(&bytes).unwrap();
    assert_eq!(
        m.tracks[0].samples.len(),
        12,
        "all clusters of an unknown-size segment must be found"
    );
    for (s, f) in m.tracks[0].samples.iter().zip(&frames) {
        assert_eq!(
            &bytes[s.offset as usize..(s.offset + s.size as u64) as usize],
            &f.data[..]
        );
    }
    assert!(m.warnings.is_empty(), "{:?}", m.warnings);
    // finite segment but unknown-size clusters
    let o2 = MkvOpts {
        unknown_segment: false,
        unknown_clusters: true,
        void_and_crc: true,
        frames_per_cluster: 5,
        ..Default::default()
    };
    assert_eq!(
        do_scan(&build_mkv(&[vtrack()], &frames, &o2))
            .unwrap()
            .tracks[0]
            .samples
            .len(),
        12
    );
}

#[test]
fn truncated_file_keeps_complete_blocks_and_warns() {
    let frames: Vec<Frame> = (0..20)
        .map(|i| Frame::new(1, i * 40, payload(1, i as usize, 100), i == 0))
        .collect();
    let o = MkvOpts {
        frames_per_cluster: 7,
        ..Default::default()
    };
    let bytes = build_mkv(&[vtrack()], &frames, &o);
    let full = do_scan(&bytes).unwrap();
    assert_eq!(full.tracks[0].samples.len(), 20);
    // cut inside the 3rd cluster (finite segment + finite cluster sizes extend beyond EOF)
    let cut = bytes.len() - 150;
    let m = do_scan(&bytes[..cut]).unwrap();
    let n = m.tracks[0].samples.len();
    assert!(
        n >= 14 && n < 20,
        "kept complete children of truncated containers, got {n}"
    );
    assert!(
        m.warnings.iter().any(|w| w.contains("truncated")),
        "{:?}",
        m.warnings
    );
    for (s, f) in m.tracks[0].samples.iter().zip(&frames) {
        assert_eq!(
            &bytes[s.offset as usize..(s.offset + s.size as u64) as usize],
            &f.data[..]
        );
    }
    // every possible truncation point after the track headers must never panic
    for cut in (0..bytes.len()).step_by(13) {
        let _ = do_scan(&bytes[..cut]);
    }
}

#[test]
fn invalid_inputs_are_errors_not_panics() {
    assert!(matches!(do_scan(&[]), Err(Error::InvalidMkv(_))));
    assert!(matches!(do_scan(&[0x1A, 0x45]), Err(Error::InvalidMkv(_))));
    assert!(matches!(do_scan(&[0u8; 1000]), Err(Error::InvalidMkv(_))));
    let garbage: Vec<u8> = (0..5000u32)
        .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
        .collect();
    assert!(matches!(do_scan(&garbage), Err(Error::InvalidMkv(_))));
    // wrong doctype
    let bad = elem(0x1A45DFA3, &str_el(0x4282, "mp4v"));
    assert!(matches!(do_scan(&bad), Err(Error::InvalidMkv(_))));
    // header only, no segment/tracks
    let hdr_only = elem(0x1A45DFA3, &str_el(0x4282, "matroska"));
    assert!(matches!(do_scan(&hdr_only), Err(Error::InvalidMkv(_))));
    // segment without tracks
    let mut no_tracks = hdr_only.clone();
    no_tracks.extend(elem(
        0x18538067,
        &elem(0x1549A966, &uint_el(0x2AD7B1, 1_000_000)),
    ));
    assert!(matches!(do_scan(&no_tracks), Err(Error::InvalidMkv(_))));
    // random corruption of a valid file never panics
    let frames = some_frames();
    let good = build_mkv(&[vtrack(), atrack()], &frames, &MkvOpts::default());
    for i in 0..good.len() {
        let mut c = good.clone();
        c[i] ^= 0xA5;
        let _ = do_scan(&c);
    }
}

#[test]
fn laced_blocks_content_encoding_and_unknown_track_blocks() {
    let mut laced = Frame::new(2, 0, payload(2, 0, 20), true);
    laced.lace = true;
    let frames = vec![
        Frame::new(1, 0, payload(1, 0, 10), true),
        laced,
        Frame::new(2, 21, payload(2, 1, 20), true),
        Frame::new(9, 5, payload(9, 0, 10), true), // track 9 does not exist
    ];
    let mut enc = TrackSpec::audio(3, "A_AAC", ASC_LC_48K_STEREO.to_vec(), 48000.0, 2);
    enc.content_encoding = true;
    let bytes = build_mkv(&[vtrack(), atrack(), enc], &frames, &MkvOpts::default());
    let m = do_scan(&bytes).unwrap();
    assert_eq!(m.tracks.len(), 3);
    assert!(m.tracks[1].laced);
    assert_eq!(
        m.tracks[1].samples.len(),
        1,
        "laced block skipped, other block kept"
    );
    assert!(!m.tracks[0].laced && !m.tracks[0].content_encoded);
    assert!(m.tracks[2].content_encoded);
    assert_eq!(m.tracks[0].samples.len(), 1);
}

#[test]
fn opus_delay_and_preroll_fields_are_preserved() {
    let mut t = TrackSpec::audio(2, "A_OPUS", opus_head(2, 312, 48000, 0, 0, &[]), 48000.0, 2);
    t.codec_delay_ns = Some(6_500_000);
    let bytes = build_mkv(
        &[t],
        &[Frame::new(2, 0, vec![0xF8, 1, 2], true)],
        &MkvOpts::default(),
    );
    assert_eq!(
        do_scan(&bytes).unwrap().tracks[0].codec_delay_ns,
        Some(6_500_000)
    );
}

#[test]
fn buffered_source_gives_identical_results_for_any_window() {
    let frames: Vec<Frame> = (0..40)
        .flat_map(|i| {
            vec![
                Frame::new(
                    1,
                    i * 40,
                    payload(1, i as usize, 90 + (i as usize % 7)),
                    i % 10 == 0,
                ),
                Frame::new(2, i * 40, payload(2, i as usize, 33), true),
            ]
        })
        .collect();
    let bytes = build_mkv(
        &[vtrack(), atrack()],
        &frames,
        &MkvOpts {
            frames_per_cluster: 9,
            ..Default::default()
        },
    );
    let reference = do_scan(&bytes).unwrap();
    for window in [1usize, 7, 64, 1000, 1 << 20] {
        let mut src = BufferedSource::new(SliceSource(&bytes), window);
        let m = scan(&mut src, &mut |_, _| {}).unwrap();
        assert_eq!(m, reference, "window {window}");
    }
    // raw BufferedSource reads equal the inner bytes, including at the end and out of range
    let mut src = BufferedSource::new(SliceSource(&bytes), 13);
    assert_eq!(src.len(), bytes.len() as u64);
    for (off, len) in [
        (0usize, 5usize),
        (3, 40),
        (bytes.len() - 7, 7),
        (100, 1),
        (50, 200),
    ] {
        let mut buf = vec![0u8; len];
        src.read_at(off as u64, &mut buf).unwrap();
        assert_eq!(&buf[..], &bytes[off..off + len]);
    }
    let mut buf = [0u8; 8];
    assert!(src.read_at(bytes.len() as u64 - 3, &mut buf).is_err());
}

#[test]
fn progress_is_monotone_and_ends_at_len() {
    let frames: Vec<Frame> = (0..60)
        .map(|i| Frame::new(1, i * 40, payload(1, i as usize, 40_000), i == 0))
        .collect();
    let bytes = build_mkv(
        &[vtrack()],
        &frames,
        &MkvOpts {
            frames_per_cluster: 5,
            ..Default::default()
        },
    );
    let mut calls: Vec<(u64, u64)> = Vec::new();
    scan(&mut SliceSource(&bytes), &mut |a, b| calls.push((a, b))).unwrap();
    assert!(calls.len() >= 2, "{calls:?}");
    assert!(calls.windows(2).all(|w| w[0].0 <= w[1].0));
    assert!(calls
        .iter()
        .all(|c| c.1 == bytes.len() as u64 && c.0 <= c.1));
    assert_eq!(
        *calls.last().unwrap(),
        (bytes.len() as u64, bytes.len() as u64)
    );
}

#[test]
fn sample_limit_returns_too_large() {
    let frames: Vec<Frame> = (0..20)
        .map(|i| Frame::new(1, i * 40, payload(1, i as usize, 10), i == 0))
        .collect();
    let bytes = build_mkv(&[vtrack()], &frames, &MkvOpts::default());
    let r = scan_with_limits(
        &mut SliceSource(&bytes),
        &mut |_, _| {},
        &Limits { max_samples: 10 },
    );
    assert!(matches!(r, Err(Error::TooLarge(_))), "{r:?}");
    assert!(scan_with_limits(
        &mut SliceSource(&bytes),
        &mut |_, _| {},
        &Limits { max_samples: 20 }
    )
    .is_ok());
    assert_eq!(Limits::default().max_samples, 20_000_000);
}

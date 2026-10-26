mod common;
use common::*;
use mkv2mp4::convert::{convert, ConvertOptions};
use mkv2mp4::error::Error;
use mkv2mp4::source::{Sink, SliceSource};

fn avc_track() -> TrackSpec {
    let mut t = TrackSpec::video(1, "V_MPEG4/ISO/AVC", AVCC.to_vec(), 320, 240);
    t.default_duration_ns = Some(41_666_667);
    t
}
fn aac_track() -> TrackSpec {
    TrackSpec::audio(2, "A_AAC", ASC_LC_48K_STEREO.to_vec(), 48000.0, 2)
}
/// 24 video frames (I at 0 and 12) interleaved with AAC frames (1024 samples @48k, ms-rounded timestamps).
fn av_frames() -> Vec<Frame> {
    let mut v = Vec::new();
    for i in 0..24usize {
        let t = (i as f64 * 41.6667).round() as i64;
        v.push((t, 1u64, payload(1, i, 200 + i * 3), i % 12 == 0));
    }
    for i in 0..47usize {
        let t = (i as f64 * 21.3333).floor() as i64;
        v.push((t, 2u64, payload(2, i, 64 + i), true));
    }
    v.sort_by_key(|x| (x.0, x.1));
    v.into_iter()
        .map(|(t, tr, d, k)| Frame::new(tr, t, d, k))
        .collect()
}
fn data_of(frames: &[Frame], track: u64) -> Vec<Vec<u8>> {
    frames
        .iter()
        .filter(|f| f.track == track)
        .map(|f| f.data.clone())
        .collect()
}

#[test]
fn h264_aac_end_to_end() {
    let frames = av_frames();
    let mkv = build_mkv(
        &[avc_track(), aac_track()],
        &frames,
        &MkvOpts {
            frames_per_cluster: 10,
            ..Default::default()
        },
    );
    let (mp4, rep) = ok_convert(&mkv);
    assert_eq!(
        mp4.top_types(),
        vec!["ftyp", "moov", "mdat"],
        "faststart layout"
    );
    let ftyp = &mp4.top[0];
    assert_eq!(&mp4.data[ftyp.payload..ftyp.payload + 4], b"isom");
    let brands = &mp4.data[ftyp.payload + 8..ftyp.end];
    assert!(brands.chunks(4).any(|b| b == b"mp41") && brands.chunks(4).any(|b| b == b"avc1"));
    assert_eq!(mp4.movie_timescale, 1000);
    assert_eq!(mp4.tracks.len(), 2);

    let v = &mp4.tracks[0];
    assert_eq!(
        (v.id, v.handler.as_str(), v.entry_type.as_str(), v.timescale),
        (1, "vide", "avc1", 90000)
    );
    assert_eq!((v.width, v.height), (320.0, 240.0));
    assert_eq!(v.volume, 0);
    assert_eq!(v.entry_child(&mp4.data, "avcC", 78).unwrap(), AVCC.to_vec());
    assert_eq!(
        v.samples(&mp4.data),
        data_of(&frames, 1),
        "video samples copied byte for byte, in order"
    );
    assert_eq!(v.stss, Some(vec![1, 13]));
    assert!(v.ctts.is_none(), "no reordering => no ctts");
    assert_eq!(v.language, "und");

    let a = &mp4.tracks[1];
    assert_eq!(
        (a.id, a.handler.as_str(), a.entry_type.as_str(), a.timescale),
        (2, "soun", "mp4a", 48000)
    );
    assert_eq!(a.volume, 0x0100);
    assert_eq!(a.language, "eng");
    assert_eq!(a.samples(&mp4.data), data_of(&frames, 2));
    assert!(a.stss.is_none(), "all-key audio has no stss");
    assert_eq!(
        a.stts,
        vec![(47, 1024)],
        "AAC ms-jitter normalised to exact 1024-sample durations"
    );
    assert_eq!(a.media_duration, 47 * 1024);
    // sample entry header: channelcount, samplesize, samplerate 16.16
    let e = a.entry.payload;
    assert_eq!(be16(&mp4.data, e + 16), 2);
    assert_eq!(be16(&mp4.data, e + 18), 16);
    assert_eq!(be32(&mp4.data, e + 24), 48000 << 16);
    // esds: ES(3){ DecoderConfig(4){0x40, 0x15, ..., DecoderSpecificInfo(5){ASC}}, SL(6){02} }
    let esds = a.entry_child(&mp4.data, "esds", 28).expect("esds");
    let d = &esds;
    let es = parse_descriptors(d, 4, d.len());
    assert_eq!(es.len(), 1);
    assert_eq!(es[0].0, 3);
    let kids = parse_descriptors(d, es[0].1 + 3, es[0].2);
    assert_eq!(kids.iter().map(|k| k.0).collect::<Vec<_>>(), vec![4, 6]);
    assert_eq!(d[kids[0].1], 0x40);
    assert_eq!(d[kids[0].1 + 1], 0x15);
    let dc = parse_descriptors(d, kids[0].1 + 13, kids[0].2);
    assert_eq!(dc.len(), 1);
    assert_eq!(dc[0].0, 5);
    assert_eq!(&d[dc[0].1..dc[0].2], &ASC_LC_48K_STEREO);
    assert_eq!(&d[kids[1].1..kids[1].2], &[2]);

    // chunk offsets point inside mdat, ordered, and the whole file parses exactly
    let mdat = &mp4.top[2];
    for t in &mp4.tracks {
        for (o, s) in t.sample_ranges() {
            assert!(o as usize >= mdat.payload && (o + s as u64) as usize <= mdat.end);
        }
        assert!(!t.co64);
    }
    // elst: a single edit per track starting at 0; durations consistent
    assert_eq!(v.edits.len(), 1);
    assert_eq!(v.edits[0].1, 0);
    assert_eq!(a.edits.len(), 1);
    assert_eq!(mp4.movie_duration, v.edits[0].0.max(a.edits[0].0));
    assert_eq!(v.tkhd_duration, v.edits[0].0);
    // report
    assert_eq!(rep.video_codec.as_deref(), Some("h264"));
    assert_eq!(rep.audio_codecs, vec!["aac".to_string()]);
    assert_eq!(rep.sample_count, 24 + 47);
    assert!(rep.warnings.is_empty(), "{:?}", rep.warnings);
    assert!(
        rep.duration_ms >= 990 && rep.duration_ms <= 1010,
        "{}",
        rep.duration_ms
    );
}

#[test]
fn bframes_end_to_end_ctts_and_edit() {
    let pts = [0i64, 120, 40, 80, 240, 160, 200];
    let frames: Vec<Frame> = pts
        .iter()
        .enumerate()
        .map(|(i, p)| Frame::new(1, *p, payload(1, i, 50), i == 0))
        .collect();
    let mut t = avc_track();
    t.default_duration_ns = Some(40_000_000);
    let mkv = build_mkv(
        &[t],
        &frames,
        &MkvOpts {
            frames_per_cluster: 3,
            ..Default::default()
        },
    );
    let (mp4, rep) = ok_convert(&mkv);
    let v = &mp4.tracks[0];
    assert!(v.ctts.is_some());
    let pres = v.presentation_ms();
    assert_eq!(
        pres.iter().map(|x| x.round() as i64).collect::<Vec<_>>(),
        pts.to_vec()
    );
    assert_eq!(mp4.movie_duration, 280);
    assert_eq!(rep.duration_ms, 280);
    assert_eq!(v.edits, vec![(280, 3600)]);
    assert_eq!(v.samples(&mp4.data), data_of(&frames, 1));
}

#[test]
fn late_audio_and_nonzero_origin() {
    // everything shifted by +1000ms, audio starts 100ms after video
    let mut frames = Vec::new();
    for i in 0..10usize {
        frames.push(Frame::new(
            1,
            1000 + i as i64 * 40,
            payload(1, i, 30),
            i == 0,
        ));
    }
    for i in 0..10usize {
        frames.push(Frame::new(
            2,
            1100 + (i as f64 * 21.3333).floor() as i64,
            payload(2, i, 20),
            true,
        ));
    }
    frames.sort_by_key(|f| (f.pts_ms, f.track));
    let (mp4, _) = ok_convert(&build_mkv(
        &[avc_track(), aac_track()],
        &frames,
        &MkvOpts::default(),
    ));
    assert_eq!(mp4.tracks[0].edits.len(), 1, "video starts at the origin");
    assert_eq!(mp4.tracks[1].edits.len(), 2);
    assert_eq!(mp4.tracks[1].edits[0], (100, -1));
    let pres = mp4.tracks[1].presentation_ms();
    assert!((pres[0] - 100.0).abs() < 0.5);
    assert!(mp4.tracks[0].presentation_ms()[0].abs() < 0.5);
}

#[test]
fn unsupported_tracks_are_skipped_with_warnings() {
    let frames = vec![
        Frame::new(1, 0, payload(1, 0, 30), true),
        Frame::new(2, 0, payload(2, 0, 30), true),
        Frame::new(3, 0, payload(3, 0, 30), true),
        Frame::new(1, 40, payload(1, 1, 30), false),
        Frame::new(2, 21, payload(2, 1, 30), true),
        Frame::new(3, 20, payload(3, 1, 30), true),
    ];
    let dts = TrackSpec::audio(2, "A_DTS", vec![], 48000.0, 6);
    let mut aac = aac_track();
    aac.number = 3;
    let mut sub = TrackSpec::audio(4, "S_TEXT/UTF8", vec![], 0.0, 1);
    sub.kind = 17;
    sub.audio = None;
    let mkv = build_mkv(&[avc_track(), dts, aac, sub], &frames, &MkvOpts::default());
    let (mp4, rep) = ok_convert(&mkv);
    assert_eq!(mp4.tracks.len(), 2);
    assert_eq!(rep.audio_codecs, vec!["aac"]);
    assert!(
        rep.warnings
            .iter()
            .any(|w| w.contains("A_DTS") && w.contains("skipped")),
        "{:?}",
        rep.warnings
    );
}

#[test]
fn audio_only_works_and_nothing_supported_is_an_error() {
    let frames: Vec<Frame> = (0..5)
        .map(|i| Frame::new(2, (i as f64 * 21.3333) as i64, payload(2, i, 30), true))
        .collect();
    let (mp4, rep) = ok_convert(&build_mkv(&[aac_track()], &frames, &MkvOpts::default()));
    assert_eq!(mp4.tracks.len(), 1);
    assert_eq!(rep.video_codec, None);
    let mut vp9 = TrackSpec::video(1, "V_VP9", vec![], 320, 240);
    vp9.default_duration_ns = Some(40_000_000);
    let f = vec![Frame::new(1, 0, payload(1, 0, 10), true)];
    match run_convert(&build_mkv(&[vp9], &f, &MkvOpts::default())) {
        Err(Error::Unsupported(m)) => assert!(m.contains("V_VP9"), "{m}"),
        other => panic!("expected Unsupported, got {:?}", other.map(|x| x.1)),
    }
}

#[test]
fn hevc_hvc1_vs_hev1() {
    let idr = |body: u8| [hevc_nal(19, &[body, 1, 2, 3])].concat();
    let trail = |body: u8| [hevc_nal(1, &[body, 9, 9])].concat();
    let mk = |cp: Vec<u8>, frames: Vec<Frame>| {
        let mut t = TrackSpec::video(1, "V_MPEGH/ISO/HEVC", cp, 320, 240);
        t.default_duration_ns = Some(40_000_000);
        let (mp4, rep) = ok_convert(&build_mkv(&[t], &frames, &MkvOpts::default()));
        assert_eq!(rep.video_codec.as_deref(), Some("hevc"));
        let v = &mp4.tracks[0];
        let hv = v.entry_child(&mp4.data, "hvcC", 78).expect("hvcC");
        assert_eq!(
            v.samples(&mp4.data),
            frames.iter().map(|f| f.data.clone()).collect::<Vec<_>>()
        );
        (v.entry_type.clone(), hv)
    };
    let plain: Vec<Frame> = vec![
        Frame::new(1, 0, idr(1), true),
        Frame::new(1, 40, trail(2), false),
        Frame::new(1, 80, idr(3), true),
    ];
    let (ty, hv) = mk(hvcc_complete(), plain.clone());
    assert_eq!(ty, "hvc1");
    assert_eq!(hv, hvcc_complete());
    // in-band parameter sets in the FIRST sample -> hev1
    let mut inband_first = plain.clone();
    inband_first[0].data = [
        hevc_nal(32, &[1]),
        hevc_nal(33, &[1]),
        hevc_nal(34, &[1]),
        idr(1),
    ]
    .concat();
    assert_eq!(mk(hvcc_complete(), inband_first).0, "hev1");
    // in-band parameter set only at a LATER keyframe -> hev1
    let mut inband_later = plain.clone();
    inband_later[2].data = [hevc_nal(33, &[7]), idr(3)].concat();
    assert_eq!(mk(hvcc_complete(), inband_later).0, "hev1");
    // array_completeness cleared on any required array -> hev1 even though nothing is in-band
    let incomplete = hvcc(&[
        (true, 32, vec![0x40, 1, 1]),
        (false, 33, vec![0x42, 1, 1]),
        (true, 34, vec![0x44, 1, 1]),
    ]);
    assert_eq!(mk(incomplete, plain.clone()).0, "hev1");
    // missing PPS array -> hev1
    let missing = hvcc(&[(true, 32, vec![0x40, 1, 1]), (true, 33, vec![0x42, 1, 1])]);
    assert_eq!(mk(missing, plain.clone()).0, "hev1");
    // malformed hvcC (arrays overrun) -> hev1, no panic
    let mut bad = hvcc_complete();
    bad.truncate(bad.len() - 2);
    assert_eq!(mk(bad, plain.clone()).0, "hev1");
    // garbage NAL lengths in a sample -> hev1, no panic
    let mut garbage = plain.clone();
    garbage[1].data = vec![0xFF, 0xFF, 0xFF, 0xFF, 1, 2, 3];
    assert_eq!(mk(hvcc_complete(), garbage).0, "hev1");
}

#[test]
fn av1_entry() {
    let av1c = vec![0x81, 0x00, 0x0C, 0x00, 0x0A, 0x0B, 0x00, 0x00, 0x00];
    let mut t = TrackSpec::video(1, "V_AV1", av1c.clone(), 320, 240);
    t.default_duration_ns = Some(41_666_667);
    let frames: Vec<Frame> = (0..4)
        .map(|i| Frame::new(1, i * 42, payload(1, i as usize, 40), i == 0))
        .collect();
    let (mp4, rep) = ok_convert(&build_mkv(&[t], &frames, &MkvOpts::default()));
    assert_eq!(mp4.tracks[0].entry_type, "av01");
    assert_eq!(
        mp4.tracks[0].entry_child(&mp4.data, "av1C", 78).unwrap(),
        av1c
    );
    assert_eq!(rep.video_codec.as_deref(), Some("av1"));
    let brands = &mp4.data[mp4.top[0].payload + 8..mp4.top[0].end];
    assert!(brands.chunks(4).any(|b| b == b"av01"));
}

#[test]
fn missing_video_codec_config_skips_video() {
    let t = TrackSpec::video(1, "V_MPEG4/ISO/AVC", vec![], 320, 240);
    let frames = vec![
        Frame::new(1, 0, payload(1, 0, 10), true),
        Frame::new(2, 0, payload(2, 0, 10), true),
    ];
    let (mp4, rep) = ok_convert(&build_mkv(&[t, aac_track()], &frames, &MkvOpts::default()));
    assert_eq!(mp4.tracks.len(), 1);
    assert!(
        rep.warnings.iter().any(|w| w.contains("codec config")),
        "{:?}",
        rep.warnings
    );
}

#[test]
fn mp3_entry() {
    let t = TrackSpec::audio(2, "A_MPEG/L3", vec![], 44100.0, 2);
    let frames: Vec<Frame> = (0..5)
        .map(|i| Frame::new(2, (i as f64 * 26.1224) as i64, payload(2, i, 417), true))
        .collect();
    let (mp4, rep) = ok_convert(&build_mkv(&[t], &frames, &MkvOpts::default()));
    let a = &mp4.tracks[0];
    assert_eq!((a.entry_type.as_str(), a.timescale), ("mp4a", 44100));
    assert_eq!(a.stts, vec![(5, 1152)]);
    assert_eq!(rep.audio_codecs, vec!["mp3"]);
    let esds = a.entry_child(&mp4.data, "esds", 28).unwrap();
    let es = parse_descriptors(&esds, 4, esds.len());
    let kids = parse_descriptors(&esds, es[0].1 + 3, es[0].2);
    assert_eq!(esds[kids[0].1], 0x6B);
    assert_eq!(
        parse_descriptors(&esds, kids[0].1 + 13, kids[0].2).len(),
        0,
        "no DecoderSpecificInfo for MP3"
    );
}

#[test]
fn esds_descriptor_lengths_127_128_16384() {
    for n in [127usize, 128, 16384] {
        let mut asc = ASC_LC_48K_STEREO.to_vec();
        asc.resize(n, 0);
        let t = TrackSpec::audio(2, "A_AAC", asc.clone(), 48000.0, 2);
        let frames: Vec<Frame> = (0..3)
            .map(|i| Frame::new(2, i * 21, payload(2, i as usize, 30), true))
            .collect();
        let (mp4, _) = ok_convert(&build_mkv(&[t], &frames, &MkvOpts::default()));
        let esds = mp4.tracks[0].entry_child(&mp4.data, "esds", 28).unwrap();
        let es = parse_descriptors(&esds, 4, esds.len());
        assert_eq!(es.len(), 1, "n={n}");
        assert_eq!(
            es[0].2,
            esds.len(),
            "ES_Descriptor spans the esds payload exactly, n={n}"
        );
        let kids = parse_descriptors(&esds, es[0].1 + 3, es[0].2);
        assert_eq!(kids.iter().map(|k| k.0).collect::<Vec<_>>(), vec![4, 6]);
        let dc = parse_descriptors(&esds, kids[0].1 + 13, kids[0].2);
        assert_eq!(dc.len(), 1);
        assert_eq!(&esds[dc[0].1..dc[0].2], &asc[..], "n={n}");
        assert_eq!(dc[0].2 - dc[0].1, n);
    }
}

#[test]
fn aac_variants_end_to_end() {
    // gap + SBR via the full pipeline
    let frames: Vec<Frame> = [0i64, 21, 43, 200]
        .iter()
        .enumerate()
        .map(|(i, t)| Frame::new(2, *t, payload(2, i, 30), true))
        .collect();
    let (mp4, _) = ok_convert(&build_mkv(&[aac_track()], &frames, &MkvOpts::default()));
    assert_eq!(mp4.tracks[0].durations(), vec![1024, 1024, 7552, 1024]);
    let mut sbr = TrackSpec::audio(2, "A_AAC", vec![0x2B, 0x11, 0x88, 0x00], 24000.0, 2);
    sbr.audio = Some((24000.0, 2, Some(48000.0)));
    let frames: Vec<Frame> = [0i64, 43, 85, 128]
        .iter()
        .enumerate()
        .map(|(i, t)| Frame::new(2, *t, payload(2, i, 30), true))
        .collect();
    let (mp4, _) = ok_convert(&build_mkv(&[sbr], &frames, &MkvOpts::default()));
    assert_eq!(mp4.tracks[0].timescale, 48000);
    assert_eq!(mp4.tracks[0].durations(), vec![2048; 4]);
    assert_eq!(
        be32(&mp4.data, mp4.tracks[0].entry.payload + 24),
        48000 << 16
    );
}

#[test]
fn opus_entry_end_trim_and_checks() {
    let build = |head: Vec<u8>, delay: Option<u64>, pads: &[Option<i64>]| {
        let mut t = TrackSpec::audio(2, "A_OPUS", head, 48000.0, 2);
        t.codec_delay_ns = delay;
        let frames: Vec<Frame> = pads
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let mut d = payload(2, i, 60);
                d[0] = 0xF8; // TOC: CELT FB 20 ms, 1 frame
                let mut f = Frame::new(2, i as i64 * 20, d, true);
                if let Some(p) = p {
                    f.group = true;
                    f.discard_padding_ns = Some(*p);
                }
                f
            })
            .collect();
        let (mp4, rep) = ok_convert(&build_mkv(&[t], &frames, &MkvOpts::default()));
        (mp4, rep)
    };
    // family 0, consistent CodecDelay (312 samples = 6.5 ms), last block trims 10 ms (480 samples)
    let head = opus_head(2, 312, 44100, -256, 0, &[]);
    let (mp4, rep) = build(
        head,
        Some(6_500_000),
        &[None, None, None, None, Some(10_000_000)],
    );
    let a = &mp4.tracks[0];
    assert_eq!((a.entry_type.as_str(), a.timescale), ("Opus", 48000));
    let dops = a.entry_child(&mp4.data, "dOps", 28).unwrap();
    assert_eq!(
        dops,
        vec![0, 2, 0x01, 0x38, 0, 0, 0xAC, 0x44, 0xFF, 0x00, 0]
    );
    assert_eq!(a.durations(), vec![960; 5], "last duration from TOC");
    assert_eq!(
        a.edits,
        vec![(90, 0)],
        "100 ms of audio minus 10 ms DiscardPadding"
    );
    assert_eq!(be32(&mp4.data, a.entry.payload + 24), 48000 << 16);
    assert_eq!(rep.audio_codecs, vec!["opus"]);
    // family 1 with mapping table
    let tail = [2u8, 0, 0, 1];
    let (mp4, _) = build(opus_head(2, 312, 48000, 0, 1, &tail), None, &[None, None]);
    let dops = mp4.tracks[0].entry_child(&mp4.data, "dOps", 28).unwrap();
    assert_eq!(
        dops,
        vec![0, 2, 0x01, 0x38, 0, 0, 0xBB, 0x80, 0, 0, 1, 2, 0, 0, 1]
    );
    // CodecDelay disagreeing with OpusHead pre-skip -> track skipped (a video track keeps the output valid)
    let mut t = TrackSpec::audio(2, "A_OPUS", opus_head(2, 312, 48000, 0, 0, &[]), 48000.0, 2);
    t.codec_delay_ns = Some(20_000_000);
    let fs = vec![
        Frame::new(1, 0, payload(1, 0, 20), true),
        Frame::new(2, 0, vec![0xF8, 1, 2], true),
    ];
    let (mp4, rep) = ok_convert(&build_mkv(&[avc_track(), t], &fs, &MkvOpts::default()));
    assert_eq!(mp4.tracks.len(), 1);
    assert!(
        rep.warnings.iter().any(|w| w.contains("CodecDelay")),
        "{:?}",
        rep.warnings
    );
    // unrepresentable DiscardPadding: negative on last, or non-zero on a non-last block -> skipped
    for pads in [
        vec![None, None, Some(-5_000_000)],
        vec![None, Some(5_000_000), None],
    ] {
        let mut t = TrackSpec::audio(2, "A_OPUS", opus_head(2, 312, 48000, 0, 0, &[]), 48000.0, 2);
        t.codec_delay_ns = Some(6_500_000);
        let mut fs = vec![Frame::new(1, 0, payload(1, 0, 20), true)];
        for (i, p) in pads.iter().enumerate() {
            let mut f = Frame::new(2, i as i64 * 20, vec![0xF8, 1, 2], true);
            if let Some(p) = p {
                f.group = true;
                f.discard_padding_ns = Some(*p);
            }
            fs.push(f);
        }
        let (mp4, rep) = ok_convert(&build_mkv(&[avc_track(), t], &fs, &MkvOpts::default()));
        assert_eq!(mp4.tracks.len(), 1);
        assert!(
            rep.warnings.iter().any(|w| w.contains("DiscardPadding")),
            "{:?}",
            rep.warnings
        );
    }
    // bad OpusHead -> skipped
    let mut t = TrackSpec::audio(2, "A_OPUS", b"NotOpus!".to_vec(), 48000.0, 2);
    t.codec_delay_ns = None;
    let fs = vec![
        Frame::new(1, 0, payload(1, 0, 20), true),
        Frame::new(2, 0, vec![0xF8, 1, 2], true),
    ];
    let (mp4, _) = ok_convert(&build_mkv(&[avc_track(), t], &fs, &MkvOpts::default()));
    assert_eq!(mp4.tracks.len(), 1);
}

#[test]
fn flac_entry_and_terminal_duration() {
    let mk = |frames: Vec<Frame>, min: u16, max: u16| {
        let t = TrackSpec::audio(2, "A_FLAC", flac_private(min, max), 44100.0, 2);
        let fs = vec![Frame::new(1, 0, payload(1, 0, 20), true)];
        let all: Vec<Frame> = fs.into_iter().chain(frames).collect();
        ok_convert(&build_mkv(&[avc_track(), t], &all, &MkvOpts::default()))
    };
    // fixed block size 4096, but the final frame is only 1000 samples
    let frames = vec![
        Frame::new(2, 0, flac_frame(4096, 100), true),
        Frame::new(2, 93, flac_frame(4096, 100), true),
        Frame::new(2, 186, flac_frame(1000, 100), true),
    ];
    let (mp4, rep) = mk(frames.clone(), 4096, 4096);
    let a = &mp4.tracks[1];
    assert_eq!((a.entry_type.as_str(), a.timescale), ("fLaC", 44100));
    assert_eq!(a.durations(), vec![4096, 4096, 1000]);
    let dfla = a.entry_child(&mp4.data, "dfLa", 28).unwrap();
    assert_eq!(&dfla[..4], &[0, 0, 0, 0]);
    assert_eq!(&dfla[4..], &flac_private(4096, 4096)[4..]);
    assert_eq!(rep.audio_codecs, vec!["flac"]);
    // variable block size stream: last duration still parsed from the last frame header
    let (mp4, _) = mk(frames.clone(), 16, 4096);
    assert_eq!(*mp4.tracks[1].durations().last().unwrap(), 1000);
    // unparseable last frame and no BlockDuration -> FLAC track skipped
    let mut bad = frames.clone();
    bad[2].data = vec![0x00; 50];
    let (mp4, rep) = mk(bad.clone(), 4096, 4096);
    assert_eq!(mp4.tracks.len(), 1);
    assert!(
        rep.warnings.iter().any(|w| w.contains("FLAC")),
        "{:?}",
        rep.warnings
    );
    // ... but an authoritative BlockDuration (10 ms = 441 units) rescues it
    bad[2].group = true;
    bad[2].duration_ms = Some(10);
    let (mp4, _) = mk(bad, 4096, 4096);
    assert_eq!(*mp4.tracks[1].durations().last().unwrap(), 441);
}

#[test]
fn ac3_entry() {
    let t = TrackSpec::audio(2, "A_AC3", vec![], 48000.0, 6);
    let frames: Vec<Frame> = (0..4)
        .map(|i| Frame::new(2, i * 32, ac3_frame(), true))
        .collect();
    let (mp4, rep) = ok_convert(&build_mkv(&[t], &frames, &MkvOpts::default()));
    let a = &mp4.tracks[0];
    assert_eq!((a.entry_type.as_str(), a.timescale), ("ac-3", 48000));
    assert_eq!(
        a.entry_child(&mp4.data, "dac3", 28).unwrap(),
        vec![0x10, 0x3C, 0xA0]
    );
    assert_eq!(be16(&mp4.data, a.entry.payload + 16), 6);
    assert_eq!(a.durations(), vec![1536; 4]);
    assert_eq!(rep.audio_codecs, vec!["ac3"]);
    // bad syncword -> skipped
    let t = TrackSpec::audio(2, "A_AC3", vec![], 48000.0, 6);
    let mut f = vec![Frame::new(1, 0, payload(1, 0, 10), true)];
    f.push(Frame::new(2, 0, vec![1, 2, 3, 4, 5, 6, 7, 8, 9], true));
    let (mp4, _) = ok_convert(&build_mkv(&[avc_track(), t], &f, &MkvOpts::default()));
    assert_eq!(mp4.tracks.len(), 1);
}

#[test]
fn display_size_and_language_in_container() {
    let mut t = avc_track();
    t.video = Some((320, 240, Some((640, 480))));
    let mut a = aac_track();
    a.language = Some("fra".into());
    let frames = vec![
        Frame::new(1, 0, payload(1, 0, 10), true),
        Frame::new(2, 0, payload(2, 0, 10), true),
    ];
    let (mp4, _) = ok_convert(&build_mkv(&[t, a], &frames, &MkvOpts::default()));
    assert_eq!((mp4.tracks[0].width, mp4.tracks[0].height), (640.0, 480.0));
    assert_eq!(be16(&mp4.data, mp4.tracks[0].entry.payload + 24), 320);
    assert_eq!(be16(&mp4.data, mp4.tracks[0].entry.payload + 26), 240);
    assert_eq!(mp4.tracks[1].language, "fra");
}

#[test]
fn unknown_size_and_void_crc_files_convert_identically() {
    let frames = av_frames();
    let plain = build_mkv(
        &[avc_track(), aac_track()],
        &frames,
        &MkvOpts {
            frames_per_cluster: 10,
            ..Default::default()
        },
    );
    let weird = build_mkv(
        &[avc_track(), aac_track()],
        &frames,
        &MkvOpts {
            frames_per_cluster: 10,
            unknown_segment: true,
            unknown_clusters: true,
            void_and_crc: true,
            ..Default::default()
        },
    );
    let a = ok_convert(&plain).0;
    let b = ok_convert(&weird).0;
    for i in 0..2 {
        assert_eq!(a.tracks[i].samples(&a.data), b.tracks[i].samples(&b.data));
        assert_eq!(a.tracks[i].stts, b.tracks[i].stts);
    }
}

#[test]
fn truncated_input_still_converts_with_warning() {
    let frames = av_frames();
    let mkv = build_mkv(
        &[avc_track(), aac_track()],
        &frames,
        &MkvOpts {
            frames_per_cluster: 10,
            ..Default::default()
        },
    );
    let cut = &mkv[..mkv.len() * 3 / 4];
    let (mp4, rep) = ok_convert(cut);
    assert!(rep.warnings.iter().any(|w| w.contains("truncated")));
    let n = mp4.tracks[0].sizes.len();
    assert!(n > 0 && n < 24);
    assert_eq!(
        mp4.tracks[0].samples(&mp4.data),
        data_of(&frames, 1)[..n].to_vec()
    );
}

#[test]
fn garbage_and_empty_input_error() {
    assert!(matches!(run_convert(&[]), Err(Error::InvalidMkv(_))));
    assert!(matches!(
        run_convert(b"this is definitely not a matroska file at all"),
        Err(Error::InvalidMkv(_))
    ));
}

#[test]
fn progress_is_monotone_and_ends_at_one() {
    let frames = av_frames();
    let mkv = build_mkv(
        &[avc_track(), aac_track()],
        &frames,
        &MkvOpts {
            frames_per_cluster: 4,
            ..Default::default()
        },
    );
    let mut calls: Vec<f64> = Vec::new();
    let mut out = Vec::new();
    convert(
        SliceSource(&mkv),
        &mut out,
        &ConvertOptions::default(),
        &mut |f| calls.push(f),
    )
    .unwrap();
    assert!(calls.len() >= 2);
    assert!(calls.iter().all(|f| (0.0..=1.0).contains(f)));
    assert!(calls.windows(2).all(|w| w[0] <= w[1]), "{calls:?}");
    assert_eq!(*calls.last().unwrap(), 1.0);
}

struct Counting {
    written: usize,
    fail_after: usize,
}
impl Sink for Counting {
    fn write(&mut self, d: &[u8]) -> mkv2mp4::error::Result<()> {
        if self.written + d.len() > self.fail_after {
            return Err(Error::Sink("boom".into()));
        }
        self.written += d.len();
        Ok(())
    }
}

#[test]
fn sink_errors_propagate_and_max_output_is_enforced_before_any_write() {
    let frames = av_frames();
    let mkv = build_mkv(&[avc_track(), aac_track()], &frames, &MkvOpts::default());
    let (full, _) = run_convert(&mkv).unwrap();
    let mut s = Counting {
        written: 0,
        fail_after: full.len() / 2,
    };
    let r = convert(
        SliceSource(&mkv),
        &mut s,
        &ConvertOptions::default(),
        &mut |_| {},
    );
    assert_eq!(r.unwrap_err(), Error::Sink("boom".into()));
    // limit smaller than the exact output size -> TooLarge and NOTHING written
    let mut s = Counting {
        written: 0,
        fail_after: usize::MAX,
    };
    let r = convert(
        SliceSource(&mkv),
        &mut s,
        &ConvertOptions {
            max_output_bytes: Some(full.len() as u64 - 1),
        },
        &mut |_| {},
    );
    assert!(matches!(r, Err(Error::TooLarge(_))), "{r:?}");
    assert_eq!(s.written, 0);
    // limit exactly equal -> ok
    let mut s = Counting {
        written: 0,
        fail_after: usize::MAX,
    };
    convert(
        SliceSource(&mkv),
        &mut s,
        &ConvertOptions {
            max_output_bytes: Some(full.len() as u64),
        },
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(s.written, full.len());
}

#[test]
fn opus_codec_delay_shifts_video_like_ffmpeg() {
    let mut t = TrackSpec::audio(2, "A_OPUS", opus_head(2, 312, 48000, 0, 0, &[]), 48000.0, 2);
    t.codec_delay_ns = Some(6_500_000);
    let mut frames = vec![
        Frame::new(1, 0, payload(1, 0, 30), true),
        Frame::new(1, 40, payload(1, 1, 30), false),
    ];
    for i in 0..4 {
        frames.push(Frame::new(2, i * 20, vec![0xF8, 1, 2, 3], true));
    }
    frames.sort_by_key(|f| (f.pts_ms, f.track));
    let (mp4, _) = ok_convert(&build_mkv(&[avc_track(), t], &frames, &MkvOpts::default()));
    let v = &mp4.tracks[0];
    assert_eq!(v.edits.len(), 2);
    assert_eq!(v.edits[0].1, -1);
    assert!((6..=7).contains(&v.edits[0].0), "{:?}", v.edits);
    assert_eq!(mp4.tracks[1].edits.len(), 1);
    let pres = v.presentation_ms();
    assert!((pres[0] - 6.5).abs() < 1.0, "{pres:?}");
    assert!(mp4.tracks[1].presentation_ms()[0].abs() < 0.01);
}

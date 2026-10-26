mod common;
use mkv2mp4::error::Error;
use mkv2mp4::mkv::{AudioInfo, Mkv, MkvTrack, SampleRef, TrackKind, VideoInfo};
use mkv2mp4::plan::{build_plan, Plan, PlanTrack};
use mkv2mp4::source::SliceSource;

fn sref(i: usize, pts_ms: i64, key: bool) -> SampleRef {
    SampleRef {
        offset: 1000 + i as u64 * 100,
        size: 50 + i as u32,
        pts_ns: pts_ms * 1_000_000,
        keyframe: key,
        duration_ns: None,
        discard_padding_ns: None,
    }
}
fn video(samples: Vec<SampleRef>, default_ns: Option<u64>) -> MkvTrack {
    MkvTrack {
        number: 1,
        kind: TrackKind::Video,
        codec_id: "V_MPEG4/ISO/AVC".into(),
        codec_private: common::AVCC.to_vec(),
        language: "und".into(),
        default_duration_ns: default_ns,
        codec_delay_ns: None,
        seek_pre_roll_ns: None,
        video: Some(VideoInfo {
            pixel_width: 320,
            pixel_height: 240,
            display_width: None,
            display_height: None,
        }),
        audio: None,
        laced: false,
        content_encoded: false,
        samples,
    }
}
fn audio(
    codec: &str,
    private: Vec<u8>,
    freq: f64,
    out: Option<f64>,
    samples: Vec<SampleRef>,
) -> MkvTrack {
    MkvTrack {
        number: 2,
        kind: TrackKind::Audio,
        codec_id: codec.into(),
        codec_private: private,
        language: "eng".into(),
        default_duration_ns: None,
        codec_delay_ns: None,
        seek_pre_roll_ns: None,
        video: None,
        audio: Some(AudioInfo {
            sampling_frequency: freq,
            output_sampling_frequency: out,
            channels: 2,
            bit_depth: None,
        }),
        laced: false,
        content_encoded: false,
        samples,
    }
}
fn aac(samples: Vec<SampleRef>) -> MkvTrack {
    audio(
        "A_AAC",
        common::ASC_LC_48K_STEREO.to_vec(),
        48000.0,
        None,
        samples,
    )
}
fn mkv(tracks: Vec<MkvTrack>) -> Mkv {
    Mkv {
        timecode_scale_ns: 1_000_000,
        duration_ns: None,
        tracks,
        warnings: vec![],
    }
}
fn plan_of(tracks: Vec<MkvTrack>) -> Result<Plan, Error> {
    build_plan(&mkv(tracks), &mut SliceSource(&[]))
}
fn samples_ms(pts: &[i64]) -> Vec<SampleRef> {
    pts.iter()
        .enumerate()
        .map(|(i, p)| sref(i, *p, i == 0))
        .collect()
}
fn conv(ns: i64, ts: u32) -> i64 {
    ((ns as i128 * ts as i128 + 500_000_000) / 1_000_000_000) as i64
}

/// Invariants every video track must satisfy: strictly increasing dts, durations >= 1, no negative cts,
/// every sample presents at its intended time r[i] = conv(pts[i]) - min conv(pts) after applying the edit's media_time.
fn check_video_invariants(t: &PlanTrack, pts_ns: &[i64]) {
    let q: Vec<i64> = pts_ns.iter().map(|p| conv(*p, t.timescale)).collect();
    let s0 = *q.iter().min().unwrap();
    let shift = t.edits.last().unwrap().media_time;
    assert!(shift >= 0);
    for w in t.samples.windows(2) {
        assert!(w[1].dts > w[0].dts, "dts must be strictly increasing");
    }
    assert!(t.samples.iter().all(|s| s.duration >= 1));
    assert_eq!(t.samples[0].dts, 0);
    for (i, s) in t.samples.iter().enumerate() {
        assert_eq!(
            s.dts as i64 + s.cts_offset as i64 - shift,
            q[i] - s0,
            "presentation invariant, sample {i}"
        );
    }
    for w in t.samples.windows(2) {
        assert_eq!(
            w[0].dts + w[0].duration as u64,
            w[1].dts,
            "durations are dts deltas"
        );
    }
    let sum: u64 = t.samples.iter().map(|s| s.duration as u64).sum();
    assert_eq!(sum, t.media_duration);
    let last_edit = t.edits.last().unwrap();
    assert!(last_edit.segment_duration >= 1);
    // every presented frame lies inside the presentation interval (movie ms)
    let pres_end_ms = (*q.iter().max().unwrap() - s0) as f64 * 1000.0 / t.timescale as f64;
    assert!(
        last_edit.segment_duration as f64 + 1.0 > pres_end_ms,
        "edit must cover the last presented frame"
    );
}

#[test]
fn bframe_reorder_presentation() {
    let pts = [0i64, 120, 40, 80];
    let p = plan_of(vec![video(samples_ms(&pts), Some(40_000_000))]).unwrap();
    let t = &p.tracks[0];
    assert_eq!(t.timescale, 90000);
    assert_eq!(
        t.samples.iter().map(|s| s.dts).collect::<Vec<_>>(),
        vec![0, 3600, 7200, 10800]
    );
    assert_eq!(
        t.samples.iter().map(|s| s.cts_offset).collect::<Vec<_>>(),
        vec![3600, 10800, 0, 0]
    );
    assert_eq!(
        t.samples.iter().map(|s| s.duration).collect::<Vec<_>>(),
        vec![3600; 4]
    );
    assert_eq!(t.media_duration, 14400);
    assert_eq!(t.edits.len(), 1);
    assert_eq!(
        (t.edits[0].segment_duration, t.edits[0].media_time),
        (160, 3600)
    );
    assert_eq!(p.duration, 160);
    assert_eq!(p.movie_timescale, 1000);
    check_video_invariants(t, &pts.map(|x| x * 1_000_000));
    // sample bookkeeping is carried through unchanged and in decode order
    assert_eq!(t.samples[1].offset, 1100);
    assert_eq!(t.samples[1].size, 51);
    assert!(t.samples[0].keyframe && !t.samples[1].keyframe);
}

#[test]
fn duplicate_pts_are_preserved_via_shift() {
    let pts = [0i64, 0, 0];
    let p = plan_of(vec![video(samples_ms(&pts), Some(11_111))]).unwrap();
    let t = &p.tracks[0];
    assert_eq!(
        t.samples.iter().map(|s| s.dts).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(
        t.samples.iter().map(|s| s.cts_offset).collect::<Vec<_>>(),
        vec![2, 1, 0]
    );
    assert_eq!(
        t.samples.iter().map(|s| s.duration).collect::<Vec<_>>(),
        vec![1, 1, 1]
    );
    check_video_invariants(t, &pts.map(|x| x * 1_000_000));
}

#[test]
fn quantised_equal_pts_in_the_middle() {
    // 1ns apart -> same unit after conversion
    let mut s = samples_ms(&[0, 40, 80, 120]);
    s[2].pts_ns = s[1].pts_ns + 1;
    let pts: Vec<i64> = s.iter().map(|x| x.pts_ns).collect();
    let p = plan_of(vec![video(s, Some(40_000_000))]).unwrap();
    check_video_invariants(&p.tracks[0], &pts);
}

#[test]
fn simple_video_without_reorder_has_zero_cts_and_single_sample_works() {
    let pts = [0i64, 42, 83, 125];
    let p = plan_of(vec![video(samples_ms(&pts), None)]).unwrap();
    let t = &p.tracks[0];
    assert!(t.samples.iter().all(|s| s.cts_offset == 0));
    assert_eq!(t.edits.last().unwrap().media_time, 0);
    check_video_invariants(t, &pts.map(|x| x * 1_000_000));
    // single sample, no default duration -> fallback duration 3000 units (documented)
    let one = plan_of(vec![video(samples_ms(&[0]), None)]).unwrap();
    assert_eq!(one.tracks[0].samples[0].duration, 3000);
    // block duration of the last-presented sample wins when known
    let mut s = samples_ms(&[0, 40]);
    s[1].duration_ns = Some(20_000_000);
    let p = plan_of(vec![video(s, Some(40_000_000))]).unwrap();
    assert_eq!(p.tracks[0].samples[1].duration, 1800);
}

#[test]
fn audio_aac_ms_jitter_gives_exact_1024_durations() {
    let p = plan_of(vec![aac(samples_ms(&[0, 21, 43, 64, 85, 107]))]).unwrap();
    let t = &p.tracks[0];
    assert_eq!(t.timescale, 48000);
    assert_eq!(
        t.samples.iter().map(|s| s.dts).collect::<Vec<_>>(),
        (0..6).map(|i| i * 1024).collect::<Vec<u64>>()
    );
    assert!(t
        .samples
        .iter()
        .all(|s| s.duration == 1024 && s.cts_offset == 0 && s.keyframe));
    assert_eq!(t.media_duration, 6 * 1024);
    assert_eq!(t.edits.len(), 1);
    assert_eq!(t.edits[0].media_time, 0);
    assert_eq!(
        t.edits[0].segment_duration,
        (6.0f64 * 1024.0 / 48.0).round() as u64
    ); // 128 ms
}

#[test]
fn audio_equal_timestamps_never_go_backwards() {
    let p = plan_of(vec![aac(samples_ms(&[0, 0, 0, 0]))]).unwrap();
    let t = &p.tracks[0];
    for w in t.samples.windows(2) {
        assert!(w[1].dts > w[0].dts);
    }
    assert!(t.samples.iter().all(|s| s.duration >= 1));
    assert_eq!(t.samples.last().unwrap().duration, 1024);
}

#[test]
fn audio_gap_is_represented_as_longer_previous_duration() {
    let p = plan_of(vec![aac(samples_ms(&[0, 21, 43, 200]))]).unwrap();
    let t = &p.tracks[0];
    assert_eq!(
        t.samples.iter().map(|s| s.dts).collect::<Vec<_>>(),
        vec![0, 1024, 2048, 9600]
    );
    assert_eq!(
        t.samples.iter().map(|s| s.duration).collect::<Vec<_>>(),
        vec![1024, 1024, 7552, 1024]
    );
}

#[test]
fn audio_aac_frame_length_variants() {
    // frameLengthFlag=1 -> 960
    let p = plan_of(vec![audio(
        "A_AAC",
        vec![0x11, 0x94],
        48000.0,
        None,
        samples_ms(&[0, 20, 40, 60]),
    )])
    .unwrap();
    assert!(p.tracks[0].samples.iter().all(|s| s.duration == 960));
    // explicit SBR (AOT 5 wrapping AAC-LC): core 24 kHz, output 48 kHz -> timescale 48000, 2048 per frame
    let p = plan_of(vec![audio(
        "A_AAC",
        vec![0x2B, 0x11, 0x88, 0x00],
        24000.0,
        Some(48000.0),
        samples_ms(&[0, 43, 85, 128]),
    )])
    .unwrap();
    assert_eq!(p.tracks[0].timescale, 48000);
    assert!(
        p.tracks[0].samples.iter().all(|s| s.duration == 2048),
        "{:?}",
        p.tracks[0]
            .samples
            .iter()
            .map(|s| s.duration)
            .collect::<Vec<_>>()
    );
    // implicit SBR signalled only via OutputSamplingFrequency == 2x
    let p = plan_of(vec![audio(
        "A_AAC",
        vec![0x13, 0x10],
        24000.0,
        Some(48000.0),
        samples_ms(&[0, 43, 85, 128]),
    )])
    .unwrap();
    assert!(p.tracks[0].samples.iter().all(|s| s.duration == 2048));
    // unsupported AOT (8 = CELP) -> AAC track skipped with a precise warning, other tracks survive
    let p = plan_of(vec![
        video(samples_ms(&[0, 40]), Some(40_000_000)),
        audio(
            "A_AAC",
            vec![0x40, 0x88],
            48000.0,
            None,
            samples_ms(&[0, 21]),
        ),
    ])
    .unwrap();
    assert_eq!(p.tracks.len(), 1);
    assert!(
        p.warnings
            .iter()
            .any(|w| w.contains("AAC") && w.contains("skipped")),
        "{:?}",
        p.warnings
    );
    // truncated / empty ASC
    let p = plan_of(vec![
        video(samples_ms(&[0, 40]), None),
        audio("A_AAC", vec![], 48000.0, None, samples_ms(&[0, 21])),
    ])
    .unwrap();
    assert_eq!(p.tracks.len(), 1);
}

#[test]
fn audio_mp3_frame_sizes() {
    let p = plan_of(vec![audio(
        "A_MPEG/L3",
        vec![],
        44100.0,
        None,
        samples_ms(&[0, 26, 52, 78]),
    )])
    .unwrap();
    assert_eq!(p.tracks[0].timescale, 44100);
    assert!(p.tracks[0].samples.iter().all(|s| s.duration == 1152));
    let p = plan_of(vec![audio(
        "A_MPEG/L3",
        vec![],
        22050.0,
        None,
        samples_ms(&[0, 26, 52, 78]),
    )])
    .unwrap();
    assert!(p.tracks[0].samples.iter().all(|s| s.duration == 576));
}

#[test]
fn global_origin_and_late_start_edits() {
    // video starts at 500ms, audio at 1000ms -> t0 = 500: video presents at 0, audio after a 500ms empty edit
    let v = video(samples_ms(&[500, 540, 580]), Some(40_000_000));
    let a = aac(samples_ms(&[1000, 1021, 1043, 1064]));
    let p = plan_of(vec![v, a]).unwrap();
    assert_eq!(p.tracks.len(), 2);
    assert_eq!(
        (p.tracks[0].track_id, p.tracks[0].kind),
        (1, TrackKind::Video)
    );
    assert_eq!(
        (p.tracks[1].track_id, p.tracks[1].kind),
        (2, TrackKind::Audio)
    );
    assert_eq!(p.tracks[0].edits.len(), 1);
    assert_eq!(p.tracks[0].samples[0].dts, 0);
    let ae = &p.tracks[1].edits;
    assert_eq!(ae.len(), 2);
    assert_eq!((ae[0].segment_duration, ae[0].media_time), (500, -1));
    assert_eq!(ae[1].media_time, 0);
    assert_eq!(p.tracks[1].samples[0].dts, 0);
    assert_eq!(p.duration, 500 + ae[1].segment_duration);
    // output order is video first even when the audio track is listed first in the file
    let a2 = aac(samples_ms(&[0, 21]));
    let mut v2 = video(samples_ms(&[0, 40]), Some(40_000_000));
    v2.number = 5;
    let mut a2 = a2;
    a2.number = 1;
    let p = plan_of(vec![a2, v2]).unwrap();
    assert_eq!(p.tracks[0].kind, TrackKind::Video);
}

#[test]
fn unsupported_and_empty_tracks_are_skipped_or_error() {
    let mut vp9 = video(samples_ms(&[0, 40]), None);
    vp9.codec_id = "V_VP9".into();
    let dts = audio("A_DTS", vec![], 48000.0, None, samples_ms(&[0, 10]));
    let r = plan_of(vec![vp9.clone(), dts.clone()]);
    match r {
        Err(Error::Unsupported(m)) => assert!(m.contains("V_VP9") && m.contains("A_DTS"), "{m}"),
        other => panic!("expected Unsupported, got {other:?}"),
    }
    let p = plan_of(vec![vp9, dts, aac(samples_ms(&[0, 21]))]).unwrap();
    assert_eq!(p.tracks.len(), 1);
    assert_eq!(p.tracks[0].kind, TrackKind::Audio);
    assert_eq!(p.tracks[0].track_id, 1);
    assert!(
        p.warnings.iter().any(|w| w.contains("V_VP9"))
            && p.warnings.iter().any(|w| w.contains("A_DTS"))
    );
    // empty track skipped
    let p = plan_of(vec![video(samples_ms(&[0, 40]), None), aac(vec![])]).unwrap();
    assert_eq!(p.tracks.len(), 1);
    assert!(!p.warnings.is_empty());
    // laced / encoded
    let mut laced = aac(samples_ms(&[0, 21]));
    laced.laced = true;
    let mut enc = aac(samples_ms(&[0, 21]));
    enc.content_encoded = true;
    enc.number = 3;
    let p = plan_of(vec![video(samples_ms(&[0, 40]), None), laced, enc]).unwrap();
    assert_eq!(p.tracks.len(), 1);
    assert!(p.warnings.iter().any(|w| w.to_lowercase().contains("lac")));
    assert!(p.warnings.iter().any(|w| w.to_lowercase().contains("encod")
        || w.to_lowercase().contains("compress")
        || w.to_lowercase().contains("encrypt")));
    // no tracks at all
    assert!(matches!(
        plan_of(vec![]),
        Err(Error::Unsupported(_)) | Err(Error::InvalidMkv(_))
    ));
}

#[test]
fn only_first_video_track_is_used() {
    let v1 = video(samples_ms(&[0, 40]), None);
    let mut v2 = video(samples_ms(&[0, 40]), None);
    v2.number = 7;
    let p = plan_of(vec![v1, v2, aac(samples_ms(&[0, 21]))]).unwrap();
    assert_eq!(
        p.tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Video)
            .count(),
        1
    );
}

#[test]
fn display_dimensions_drive_tkhd_pixel_dimensions_drive_entry() {
    let mut v = video(samples_ms(&[0, 40]), None);
    v.video = Some(VideoInfo {
        pixel_width: 320,
        pixel_height: 240,
        display_width: Some(640),
        display_height: Some(480),
    });
    let p = plan_of(vec![v]).unwrap();
    assert_eq!((p.tracks[0].width, p.tracks[0].height), (640, 480));
    let e = &p.tracks[0].sample_entry;
    assert_eq!(&e[4..8], b"avc1");
    assert_eq!(u16::from_be_bytes([e[8 + 24], e[8 + 25]]), 320);
    assert_eq!(u16::from_be_bytes([e[8 + 26], e[8 + 27]]), 240);
    assert_eq!(p.tracks[0].codec_name, "h264");
}

#[test]
fn interleave_chunks_cover_every_sample_once_in_time_order() {
    let vs: Vec<SampleRef> = (0..48)
        .map(|i| sref(i * 2, (i as i64) * 42, i == 0))
        .collect();
    let as_: Vec<SampleRef> = (0..100)
        .map(|i| sref(i * 2 + 1, (i as i64) * 21, true))
        .collect();
    let p = plan_of(vec![video(vs, Some(41_666_667)), aac(as_)]).unwrap();
    let mut next = [0usize; 2];
    let mut rel = 0u64;
    let mut last_start_sec = -1.0f64;
    for c in &p.chunks {
        assert_eq!(
            c.first_sample, next[c.track],
            "chunks of a track are consecutive"
        );
        assert!(c.sample_count >= 1 && c.sample_count <= 512);
        assert_eq!(c.rel_offset, rel);
        let t = &p.tracks[c.track];
        let start = t.samples[c.first_sample].dts as f64 / t.timescale as f64;
        assert!(start + 1e-9 >= last_start_sec, "chunks are ordered by time");
        last_start_sec = start;
        for s in &t.samples[c.first_sample..c.first_sample + c.sample_count] {
            rel += s.size as u64;
        }
        let first = t.samples[c.first_sample].dts as f64 / t.timescale as f64;
        let last = t.samples[c.first_sample + c.sample_count - 1].dts as f64 / t.timescale as f64;
        assert!(
            last - first < 0.5 + 1e-9,
            "chunk spans < 500ms of dts before its final sample"
        );
        next[c.track] += c.sample_count;
    }
    assert_eq!(next, [p.tracks[0].samples.len(), p.tracks[1].samples.len()]);
    assert_eq!(rel, p.mdat_payload_size);
}

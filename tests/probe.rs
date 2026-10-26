mod common;
use common::*;
use mkv2mp4::convert::{convert, probe, ConvertOptions};
use mkv2mp4::error::Error;
use mkv2mp4::mkv::TrackKind;
use mkv2mp4::source::{Sink, SliceSource, Source};
use std::cell::Cell;
use std::rc::Rc;

fn avc_track() -> TrackSpec {
    let mut t = TrackSpec::video(1, "V_MPEG4/ISO/AVC", AVCC.to_vec(), 320, 240);
    t.default_duration_ns = Some(41_666_667);
    t
}
fn aac_track(number: u64) -> TrackSpec {
    TrackSpec::audio(number, "A_AAC", ASC_LC_48K_STEREO.to_vec(), 48000.0, 2)
}
fn av_frames(audio_tracks: &[u64]) -> Vec<Frame> {
    let mut v = Vec::new();
    for i in 0..24usize {
        v.push(Frame::new(
            1,
            (i as f64 * 41.6667).round() as i64,
            payload(1, i, 200 + i),
            i % 12 == 0,
        ));
    }
    for tr in audio_tracks {
        for i in 0..47usize {
            v.push(Frame::new(
                *tr,
                (i as f64 * 21.3333).floor() as i64,
                payload(*tr as u8, i, 64),
                true,
            ));
        }
    }
    v.sort_by_key(|f| (f.pts_ms, f.track));
    v
}

/// probe and convert must agree exactly on everything probe reports.
fn assert_probe_matches_convert(mkv: &[u8]) -> mkv2mp4::convert::ProbeReport {
    let p = probe(SliceSource(mkv)).expect("probe");
    let mut out = Vec::new();
    let r = convert(
        SliceSource(mkv),
        &mut out,
        &ConvertOptions::default(),
        &mut |_| {},
    )
    .expect("convert");
    assert_eq!(
        p.output_size, r.output_size,
        "probe.output_size == ConvertReport.output_size"
    );
    assert_eq!(
        p.output_size,
        out.len() as u64,
        "probe.output_size == actual sink length"
    );
    assert_eq!(p.duration_ms, r.duration_ms);
    assert_eq!(p.warnings, r.warnings);
    assert_eq!(
        p.tracks.iter().map(|t| t.sample_count).sum::<u64>(),
        r.sample_count
    );
    let video: Option<String> = p
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .map(|t| t.codec.clone());
    assert_eq!(video, r.video_codec);
    let audio: Vec<String> = p
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Audio)
        .map(|t| t.codec.clone())
        .collect();
    assert_eq!(audio, r.audio_codecs);
    p
}

#[test]
fn single_av_file_probe_details() {
    let mkv = build_mkv(
        &[avc_track(), aac_track(2)],
        &av_frames(&[2]),
        &MkvOpts {
            frames_per_cluster: 10,
            ..Default::default()
        },
    );
    let p = assert_probe_matches_convert(&mkv);
    assert_eq!(p.tracks.len(), 2);
    let v = &p.tracks[0];
    assert_eq!(
        (v.kind, v.codec.as_str(), v.width, v.height, v.sample_count),
        (TrackKind::Video, "h264", 320, 240, 24)
    );
    assert_eq!(
        (v.channels, v.sample_rate, v.language.as_str()),
        (0, 0, "und")
    );
    let a = &p.tracks[1];
    assert_eq!(
        (
            a.kind,
            a.codec.as_str(),
            a.channels,
            a.sample_rate,
            a.language.as_str(),
            a.sample_count
        ),
        (TrackKind::Audio, "aac", 2, 48000, "eng", 47)
    );
    assert_eq!((a.width, a.height), (0, 0));
    assert!(
        p.duration_ms >= 990 && p.duration_ms <= 1010,
        "{}",
        p.duration_ms
    );
}

#[test]
fn multi_track_with_skipped_tracks_matches_convert_and_reports_warnings() {
    let dts = TrackSpec::audio(3, "A_DTS", vec![], 48000.0, 6);
    let mut a2 = aac_track(2);
    a2.language = Some("fra".into());
    let mut frames = av_frames(&[2, 4]);
    frames.push(Frame::new(3, 0, payload(3, 0, 30), true));
    frames.sort_by_key(|f| (f.pts_ms, f.track));
    let mkv = build_mkv(
        &[avc_track(), a2, dts, aac_track(4)],
        &frames,
        &MkvOpts::default(),
    );
    let p = assert_probe_matches_convert(&mkv);
    assert_eq!(p.tracks.len(), 3, "video + two AAC; DTS skipped");
    assert_eq!(p.tracks[1].language, "fra");
    assert!(
        p.warnings
            .iter()
            .any(|w| w.contains("A_DTS") && w.contains("skipped")),
        "{:?}",
        p.warnings
    );
}

#[test]
fn truncated_file_probe_matches_convert() {
    let mkv = build_mkv(
        &[avc_track(), aac_track(2)],
        &av_frames(&[2]),
        &MkvOpts {
            frames_per_cluster: 10,
            ..Default::default()
        },
    );
    let cut = &mkv[..mkv.len() * 3 / 4];
    let p = assert_probe_matches_convert(cut);
    assert!(p.warnings.iter().any(|w| w.contains("truncated")));
}

#[test]
fn hevc_and_audio_only_probe() {
    let mut t = TrackSpec::video(1, "V_MPEGH/ISO/HEVC", hvcc_complete(), 640, 360);
    t.default_duration_ns = Some(40_000_000);
    let frames: Vec<Frame> = (0..5)
        .map(|i| {
            Frame::new(
                1,
                i * 40,
                hevc_nal(if i == 0 { 19 } else { 1 }, &[1, 2, 3]),
                i == 0,
            )
        })
        .collect();
    let p = assert_probe_matches_convert(&build_mkv(&[t], &frames, &MkvOpts::default()));
    assert_eq!(
        (
            p.tracks[0].codec.as_str(),
            p.tracks[0].width,
            p.tracks[0].height
        ),
        ("hevc", 640, 360)
    );
    let af: Vec<Frame> = (0..5)
        .map(|i| Frame::new(2, (i as f64 * 21.3333) as i64, payload(2, i, 30), true))
        .collect();
    let p = assert_probe_matches_convert(&build_mkv(&[aac_track(2)], &af, &MkvOpts::default()));
    assert_eq!(p.tracks.len(), 1);
    assert_eq!(p.tracks[0].kind, TrackKind::Audio);
}

#[test]
fn errors_are_identical_to_convert() {
    // unsupported only
    let mut vp9 = TrackSpec::video(1, "V_VP9", vec![], 320, 240);
    vp9.default_duration_ns = Some(40_000_000);
    let mkv = build_mkv(
        &[vp9],
        &[Frame::new(1, 0, payload(1, 0, 10), true)],
        &MkvOpts::default(),
    );
    let e1 = probe(SliceSource(&mkv)).unwrap_err();
    let e2 = convert(
        SliceSource(&mkv),
        &mut Vec::new(),
        &ConvertOptions::default(),
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(e1, e2);
    assert!(matches!(e1, Error::Unsupported(ref m) if m.contains("V_VP9")));
    // garbage / empty
    for bytes in [
        &b""[..],
        &b"definitely not matroska at all"[..],
        &[0u8; 300][..],
    ] {
        let e1 = probe(SliceSource(bytes)).unwrap_err();
        let e2 = convert(
            SliceSource(bytes),
            &mut Vec::new(),
            &ConvertOptions::default(),
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(e1, e2);
        assert!(matches!(e1, Error::InvalidMkv(_)));
    }
}

struct CountSrc<'a> {
    data: &'a [u8],
    bytes: Rc<Cell<u64>>,
}
impl Source for CountSrc<'_> {
    fn len(&self) -> u64 {
        self.data.len() as u64
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> mkv2mp4::error::Result<()> {
        let o = offset as usize;
        if o + buf.len() > self.data.len() {
            return Err(Error::Io("range".into()));
        }
        buf.copy_from_slice(&self.data[o..o + buf.len()]);
        self.bytes.set(self.bytes.get() + buf.len() as u64);
        Ok(())
    }
}

#[test]
fn probe_is_cheap_on_large_frames_and_writes_nothing() {
    let mut v = avc_track();
    v.default_duration_ns = Some(41_666_667);
    let mut frames = Vec::new();
    for i in 0..40usize {
        frames.push(Frame::new(
            1,
            i as i64 * 42,
            payload(1, i, 200_000),
            i % 10 == 0,
        ));
    }
    for i in 0..80usize {
        frames.push(Frame::new(
            2,
            (i as f64 * 21.3333) as i64,
            payload(2, i, 300),
            true,
        ));
    }
    frames.sort_by_key(|f| (f.pts_ms, f.track));
    let mkv = build_mkv(
        &[v, aac_track(2)],
        &frames,
        &MkvOpts {
            frames_per_cluster: 20,
            ..Default::default()
        },
    );
    let bytes = Rc::new(Cell::new(0));
    let p = probe(CountSrc {
        data: &mkv,
        bytes: bytes.clone(),
    })
    .unwrap();
    assert!(p.output_size > 8_000_000);
    let ratio = bytes.get() as f64 / mkv.len() as f64;
    assert!(
        // Spec change (F4): 64 KiB minimum read window trades bytes for far fewer browser IPC calls.
        ratio <= 0.4,
        "probe must only read headers, read {ratio:.2}x of the file"
    );
    // a Sink-less API: nothing to assert about writes except that probe compiles without one
    struct NoSink;
    impl Sink for NoSink {
        fn write(&mut self, _: &[u8]) -> mkv2mp4::error::Result<()> {
            panic!("probe must not write")
        }
    }
    let _ = NoSink;
}

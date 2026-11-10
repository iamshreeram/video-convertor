//! Re-encoded audio (e.g. Vorbis -> AAC/Opus done by the browser) replacing an MKV audio track.
//!
//! MP4 cannot carry Vorbis, so the page decodes the Vorbis packets and re-encodes them with
//! WebCodecs. The encoded packets live in an "extra" source appended after the file; a
//! `TrackReplacement` describes them and the existing MP4 writer handles the rest.

mod common;
use common::*;
use mkv2mp4::convert::{
    convert, convert_with_replacements, export_track_packets, probe, probe_with_replacements,
    ConvertOptions, ReplacementSample, TrackReplacement,
};
use mkv2mp4::error::Error;
use mkv2mp4::source::SliceSource;

const VORBIS_ID: &str = "A_VORBIS";

fn avc_track() -> TrackSpec {
    let mut t = TrackSpec::video(1, "V_MPEG4/ISO/AVC", AVCC.to_vec(), 320, 240);
    t.default_duration_ns = Some(40_000_000);
    t
}

fn vorbis_track() -> TrackSpec {
    // Contents of CodecPrivate do not matter to the remuxer; the browser decoder reads them.
    TrackSpec::audio(2, VORBIS_ID, vec![2, 30, 40, 1, 2, 3, 4, 5], 44100.0, 2)
}

fn mkv_with_vorbis() -> (Vec<u8>, Vec<Vec<u8>>) {
    let mut frames = Vec::new();
    let mut vorbis_payloads = Vec::new();
    for i in 0..25usize {
        frames.push(Frame::new(
            1,
            i as i64 * 40,
            payload(1, i, 300),
            i % 12 == 0,
        ));
    }
    for i in 0..43usize {
        let data = payload(2, i, 90 + i);
        vorbis_payloads.push(data.clone());
        frames.push(Frame::new(2, (i as f64 * 23.2).round() as i64, data, true));
    }
    frames.sort_by_key(|f| (f.pts_ms, f.track));
    let bytes = build_mkv(
        &[avc_track(), vorbis_track()],
        &frames,
        &MkvOpts {
            frames_per_cluster: 10,
            ..Default::default()
        },
    );
    (bytes, vorbis_payloads)
}

/// `n` encoded AAC frames (1024 samples at 48 kHz = 21.333 ms) as the browser would produce.
fn aac_replacement(n: usize) -> (TrackReplacement, Vec<u8>, Vec<Vec<u8>>) {
    let mut extra = Vec::new();
    let mut samples = Vec::new();
    let mut payloads = Vec::new();
    for i in 0..n {
        let p = payload(9, i, 50 + (i % 7));
        samples.push(ReplacementSample {
            size: p.len() as u32,
            pts_ns: (i as f64 * 1024.0f64 / 48000.0 * 1e9).round() as i64,
            duration_ns: (1024.0f64 / 48000.0 * 1e9).round() as u64,
        });
        extra.extend_from_slice(&p);
        payloads.push(p);
    }
    let rep = TrackReplacement {
        track_number: 2,
        codec_id: "A_AAC".into(),
        codec_private: ASC_LC_48K_STEREO.to_vec(),
        sample_rate: 48000.0,
        channels: 2,
        codec_delay_ns: None,
        samples,
    };
    (rep, extra, payloads)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn probe_reports_vorbis_as_reencodable_and_skips_it_by_default() {
    let (bytes, _) = mkv_with_vorbis();
    let report = probe(SliceSource(&bytes)).expect("probe");
    assert_eq!(
        report.tracks.len(),
        1,
        "only video is selected without re-encoding"
    );
    assert_eq!(report.reencodable.len(), 1);
    let r = &report.reencodable[0];
    assert_eq!(
        (r.number, r.codec_id.as_str(), r.channels),
        (2, VORBIS_ID, 2)
    );
    assert_eq!(r.sample_rate, 44100);
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("A_VORBIS") && w.contains("re-encod")),
        "the skip reason must explain that re-encoding is needed: {:?}",
        report.warnings
    );
}

#[test]
fn export_track_packets_returns_the_original_packets_in_order() {
    let (bytes, vorbis) = mkv_with_vorbis();
    let mut got: Vec<(i64, Vec<u8>)> = Vec::new();
    let info = export_track_packets(SliceSource(&bytes), 2, &mut |pts, data| {
        got.push((pts, data.to_vec()));
        Ok(())
    })
    .expect("export");
    assert_eq!(info.codec_id, VORBIS_ID);
    assert_eq!(info.codec_private, vec![2, 30, 40, 1, 2, 3, 4, 5]);
    assert_eq!((info.channels, info.sample_rate), (2, 44100.0));
    assert_eq!(got.len(), vorbis.len());
    for (g, v) in got.iter().zip(&vorbis) {
        assert_eq!(&g.1, v);
    }
    assert!(
        got.windows(2).all(|w| w[0].0 <= w[1].0),
        "timestamps ascend"
    );
    assert!(matches!(
        export_track_packets(SliceSource(&bytes), 99, &mut |_, _| Ok(())),
        Err(Error::Unsupported(_)) | Err(Error::InvalidMkv(_))
    ));
}

#[test]
fn replacement_adds_an_aac_track_with_the_encoded_packets() {
    let (bytes, _) = mkv_with_vorbis();
    let (rep, extra, payloads) = aac_replacement(100);
    let reps = [rep];

    let probed = probe_with_replacements(SliceSource(&bytes), SliceSource(&extra), &reps)
        .expect("probe with replacement");
    let audio: Vec<_> = probed.tracks.iter().filter(|t| t.codec == "aac").collect();
    assert_eq!(audio.len(), 1);
    assert_eq!(
        (
            audio[0].channels,
            audio[0].sample_rate,
            audio[0].sample_count
        ),
        (2, 48000, 100)
    );
    assert!(
        probed.warnings.iter().all(|w| !w.contains("A_VORBIS")),
        "no skip warning once the track is replaced: {:?}",
        probed.warnings
    );
    assert!(probed.reencodable.is_empty(), "nothing left to re-encode");

    let mut out: Vec<u8> = Vec::new();
    let report = convert_with_replacements(
        SliceSource(&bytes),
        SliceSource(&extra),
        &reps,
        &mut out,
        &ConvertOptions::default(),
        &mut |_| {},
    )
    .expect("convert with replacement");
    assert_eq!(
        out.len() as u64,
        probed.output_size,
        "probe size == output size"
    );
    assert_eq!(report.output_size, out.len() as u64);
    assert_eq!(report.audio_codecs, vec!["aac".to_string()]);
    assert!(contains(&out, b"mp4a"));
    assert!(contains(&out, b"esds"));
    for i in [0usize, 1, 50, 99] {
        assert!(
            contains(&out, &payloads[i]),
            "encoded packet {i} is in mdat"
        );
    }
}

#[test]
fn opus_replacement_is_accepted() {
    let (bytes, _) = mkv_with_vorbis();
    let mut extra = Vec::new();
    let mut samples = Vec::new();
    for i in 0..60usize {
        let mut p = payload(5, i, 70);
        p[0] = 0xF8; // TOC: CELT fullband, 20 ms, one frame
        samples.push(ReplacementSample {
            size: p.len() as u32,
            pts_ns: i as i64 * 20_000_000,
            duration_ns: 20_000_000,
        });
        extra.extend_from_slice(&p);
    }
    let rep = TrackReplacement {
        track_number: 2,
        codec_id: "A_OPUS".into(),
        codec_private: opus_head(2, 312, 44100, 0, 0, &[]),
        sample_rate: 48000.0,
        channels: 2,
        codec_delay_ns: Some(6_500_000),
        samples,
    };
    let mut out: Vec<u8> = Vec::new();
    let report = convert_with_replacements(
        SliceSource(&bytes),
        SliceSource(&extra),
        &[rep],
        &mut out,
        &ConvertOptions::default(),
        &mut |_| {},
    )
    .expect("opus replacement");
    assert_eq!(report.audio_codecs, vec!["opus".to_string()]);
    assert!(contains(&out, b"Opus") && contains(&out, b"dOps"));
}

#[test]
fn invalid_replacements_are_rejected_without_output() {
    let (bytes, _) = mkv_with_vorbis();
    let (good, extra, _) = aac_replacement(10);
    let run = |reps: Vec<TrackReplacement>, extra: &[u8]| {
        let mut out: Vec<u8> = Vec::new();
        let r = convert_with_replacements(
            SliceSource(&bytes),
            SliceSource(extra),
            &reps,
            &mut out,
            &ConvertOptions::default(),
            &mut |_| {},
        );
        (r, out)
    };

    let mut unknown = good.clone();
    unknown.track_number = 77;
    let (r, out) = run(vec![unknown], &extra);
    assert!(r.is_err() && out.is_empty(), "unknown track number");

    let mut video_target = good.clone();
    video_target.track_number = 1;
    let (r, out) = run(vec![video_target], &extra);
    assert!(
        r.is_err() && out.is_empty(),
        "must not replace a video track"
    );

    let (r, out) = run(vec![good.clone()], &extra[..extra.len() - 1]);
    assert!(
        r.is_err() && out.is_empty(),
        "extra data shorter than the sample table"
    );

    let mut empty = good.clone();
    empty.samples.clear();
    let (r, out) = run(vec![empty], &extra);
    assert!(r.is_err() && out.is_empty(), "no samples");

    let (r, out) = run(vec![good.clone(), good], &extra);
    assert!(r.is_err() && out.is_empty(), "same track replaced twice");
}

#[test]
fn convert_without_replacements_is_unchanged() {
    let (bytes, _) = mkv_with_vorbis();
    let mut a: Vec<u8> = Vec::new();
    convert(
        SliceSource(&bytes),
        &mut a,
        &ConvertOptions::default(),
        &mut |_| {},
    )
    .unwrap();
    let mut b: Vec<u8> = Vec::new();
    convert_with_replacements(
        SliceSource(&bytes),
        SliceSource(&[]),
        &[],
        &mut b,
        &ConvertOptions::default(),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(a, b);
}

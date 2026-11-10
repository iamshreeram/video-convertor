//! The scan pass reads every byte of the input. The browser used to run it up to four times
//! (probe, packet export, re-probe, convert). `Scanned` keeps the result so it runs once; these
//! tests pin that the reuse is exact (same reports, same MP4 bytes) and really saves reads.

mod common;
use common::*;
use mkv2mp4::convert::{
    convert, convert_with_replacements, export_track_packets, probe, probe_with_replacements,
    scan_source, ConvertOptions, ReplacementSample, TrackReplacement,
};
use mkv2mp4::error::{Error, Result};
use mkv2mp4::source::{EmptySource, SliceSource, Source};
use std::cell::Cell;
use std::rc::Rc;

fn mkv() -> Vec<u8> {
    let v = TrackSpec::video(1, "V_MPEG4/ISO/AVC", AVCC.to_vec(), 320, 240);
    let a = TrackSpec::audio(2, "A_AAC", ASC_LC_48K_STEREO.to_vec(), 48000.0, 2);
    let mut frames = Vec::new();
    for i in 0..60usize {
        frames.push(Frame::new(
            1,
            i as i64 * 40,
            payload(1, i, 4000),
            i % 12 == 0,
        ));
        frames.push(Frame::new(2, i as i64 * 40, payload(2, i, 300), true));
    }
    frames.sort_by_key(|f| (f.pts_ms, f.track));
    build_mkv(
        &[v, a],
        &frames,
        &MkvOpts {
            frames_per_cluster: 10,
            ..Default::default()
        },
    )
}

/// Counts bytes requested from the underlying data.
struct Counting {
    data: Vec<u8>,
    bytes: Rc<Cell<u64>>,
}
impl Source for Counting {
    fn len(&self) -> u64 {
        self.data.len() as u64
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<()> {
        self.bytes.set(self.bytes.get() + buf.len() as u64);
        SliceSource(&self.data).read_at(offset, buf)
    }
}

#[test]
fn probe_after_one_scan_equals_the_one_shot_probe() {
    let bytes = mkv();
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    let a = scanned
        .probe(SliceSource(&bytes), EmptySource, &[])
        .unwrap();
    let b = probe(SliceSource(&bytes)).unwrap();
    assert_eq!(a, b);
    // probing twice from the same scan gives the same answer (the scan is not consumed)
    let c = scanned
        .probe(SliceSource(&bytes), EmptySource, &[])
        .unwrap();
    assert_eq!(a, c);
}

#[test]
fn convert_after_one_scan_is_byte_identical() {
    let bytes = mkv();
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    let mut out = Vec::new();
    let report = scanned
        .convert(
            SliceSource(&bytes),
            EmptySource,
            &[],
            &mut out,
            &ConvertOptions::default(),
            &mut |_| {},
        )
        .unwrap();
    let (expected, expected_report) = run_convert(&bytes).unwrap();
    assert_eq!(out, expected, "MP4 bytes must not depend on scan reuse");
    assert_eq!(report, expected_report);
}

#[test]
fn progress_after_a_scan_covers_zero_to_one_monotonically() {
    let bytes = mkv();
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    let mut seen = Vec::new();
    let mut out = Vec::new();
    scanned
        .convert(
            SliceSource(&bytes),
            EmptySource,
            &[],
            &mut out,
            &ConvertOptions::default(),
            &mut |f| seen.push(f),
        )
        .unwrap();
    assert_eq!(seen.first().copied(), Some(0.0));
    assert_eq!(seen.last().copied(), Some(1.0));
    assert!(
        seen.windows(2).all(|w| w[1] > w[0]),
        "strictly increasing: {seen:?}"
    );
}

#[test]
fn size_limit_still_applies_after_a_scan() {
    let bytes = mkv();
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    let mut out = Vec::new();
    let err = scanned
        .convert(
            SliceSource(&bytes),
            EmptySource,
            &[],
            &mut out,
            &ConvertOptions {
                max_output_bytes: Some(100),
            },
            &mut |_| {},
        )
        .unwrap_err();
    assert!(matches!(err, Error::TooLarge(_)), "{err:?}");
    assert!(out.is_empty(), "nothing is written before the size check");
}

#[test]
fn export_and_replacement_flow_reuses_the_scan() {
    let bytes = mkv();
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    let mut a: Vec<(i64, Vec<u8>)> = Vec::new();
    let info_a = scanned
        .export_track_packets(SliceSource(&bytes), 2, &mut |ts, d| {
            a.push((ts, d.to_vec()));
            Ok(())
        })
        .unwrap();
    let mut b: Vec<(i64, Vec<u8>)> = Vec::new();
    let info_b = export_track_packets(SliceSource(&bytes), 2, &mut |ts, d| {
        b.push((ts, d.to_vec()));
        Ok(())
    })
    .unwrap();
    assert_eq!(a, b);
    assert_eq!(info_a, info_b);

    // replacement of track 2 by two re-encoded packets
    let extra: Vec<u8> = (0..20u8).collect();
    let rep = TrackReplacement {
        track_number: 2,
        codec_id: "A_AAC".into(),
        codec_private: ASC_LC_48K_STEREO.to_vec(),
        sample_rate: 48000.0,
        channels: 2,
        codec_delay_ns: None,
        samples: vec![
            ReplacementSample {
                size: 10,
                pts_ns: 0,
                duration_ns: 21_333_333,
            },
            ReplacementSample {
                size: 10,
                pts_ns: 21_333_333,
                duration_ns: 21_333_333,
            },
        ],
    };
    let reps = [rep];
    let p1 = scanned
        .probe(SliceSource(&bytes), SliceSource(&extra), &reps)
        .unwrap();
    let p2 = probe_with_replacements(SliceSource(&bytes), SliceSource(&extra), &reps).unwrap();
    assert_eq!(p1, p2);
    let mut o1 = Vec::new();
    scanned
        .convert(
            SliceSource(&bytes),
            SliceSource(&extra),
            &reps,
            &mut o1,
            &ConvertOptions::default(),
            &mut |_| {},
        )
        .unwrap();
    let mut o2 = Vec::new();
    convert_with_replacements(
        SliceSource(&bytes),
        SliceSource(&extra),
        &reps,
        &mut o2,
        &ConvertOptions::default(),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(o1, o2);
}

#[test]
fn scanning_once_saves_a_full_pass_over_the_input() {
    let bytes = mkv();
    let size = bytes.len() as u64;

    // old flow: probe, then convert (each scans the whole file)
    let old = Rc::new(Cell::new(0u64));
    let src = || Counting {
        data: bytes.clone(),
        bytes: old.clone(),
    };
    probe(src()).unwrap();
    let mut out = Vec::new();
    convert(src(), &mut out, &ConvertOptions::default(), &mut |_| {}).unwrap();

    // new flow: scan once, probe and convert from the saved scan
    let new = Rc::new(Cell::new(0u64));
    let src2 = || Counting {
        data: bytes.clone(),
        bytes: new.clone(),
    };
    let scanned = scan_source(src2(), &mut |_, _| {}).unwrap();
    scanned.probe(src2(), EmptySource, &[]).unwrap();
    let mut out2 = Vec::new();
    scanned
        .convert(
            src2(),
            EmptySource,
            &[],
            &mut out2,
            &ConvertOptions::default(),
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(out, out2);
    assert!(
        old.get() >= new.get() + size * 8 / 10,
        "old flow read {} bytes, new flow {} (file is {size}): expected about one pass less",
        old.get(),
        new.get()
    );
}

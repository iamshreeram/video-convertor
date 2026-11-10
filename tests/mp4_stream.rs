//! Pull-style output: `Scanned::into_stream` hands the MP4 out block by block, so a caller whose
//! sink is asynchronous (the browser's file-save API) can await each write. The bytes must be
//! exactly what the push API (`convert`) writes, and the file must be read once, not many times.

mod common;
use common::*;
use mkv2mp4::convert::{
    convert_with_replacements, scan_source, ConvertOptions, ConvertStream, ReplacementSample,
    TrackReplacement,
};
use mkv2mp4::error::{Error, Result};
use mkv2mp4::source::{EmptySource, SliceSource, Source};
use std::cell::Cell;
use std::rc::Rc;

fn avc_track() -> TrackSpec {
    let mut t = TrackSpec::video(1, "V_MPEG4/ISO/AVC", AVCC.to_vec(), 320, 240);
    t.default_duration_ns = Some(40_000_000);
    t
}

/// AAC + H.264, interleaved, 60 frames.
fn plain_mkv() -> Vec<u8> {
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
        &[avc_track(), a],
        &frames,
        &MkvOpts {
            frames_per_cluster: 10,
            ..Default::default()
        },
    )
}

/// H.264 with `video_len`-byte frames plus a Vorbis track (to be replaced by re-encoded audio).
fn vorbis_mkv(frames: usize, video_len: usize) -> Vec<u8> {
    let vorbis = TrackSpec::audio(2, "A_VORBIS", vec![2, 30, 40, 1, 2, 3, 4, 5], 44100.0, 2);
    let mut all = Vec::new();
    for i in 0..frames {
        all.push(Frame::new(
            1,
            i as i64 * 40,
            payload(1, i, video_len),
            i % 12 == 0,
        ));
    }
    let audio_frames = frames * 40 * 441 / 10 / 1024 + 1;
    for i in 0..audio_frames {
        all.push(Frame::new(
            2,
            (i as f64 * 23.2).round() as i64,
            payload(2, i, 90 + i % 13),
            true,
        ));
    }
    all.sort_by_key(|f| (f.pts_ms, f.track));
    build_mkv(
        &[avc_track(), vorbis],
        &all,
        &MkvOpts {
            frames_per_cluster: 10,
            ..Default::default()
        },
    )
}

/// `n` re-encoded AAC frames as the browser would produce them, and their bytes.
fn aac_replacement(n: usize) -> (TrackReplacement, Vec<u8>) {
    let mut extra = Vec::new();
    let mut samples = Vec::new();
    for i in 0..n {
        let p = payload(9, i, 50 + (i % 7));
        samples.push(ReplacementSample {
            size: p.len() as u32,
            pts_ns: (i as f64 * 1024.0f64 / 48000.0 * 1e9).round() as i64,
            duration_ns: (1024.0f64 / 48000.0 * 1e9).round() as u64,
        });
        extra.extend_from_slice(&p);
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
    (rep, extra)
}

/// Counts the bytes requested from the underlying data and can be told to fail.
struct Counting {
    data: Vec<u8>,
    bytes: Rc<Cell<u64>>,
    /// When set, every read fails.
    broken: Rc<Cell<bool>>,
}
impl Counting {
    fn new(data: Vec<u8>) -> (Self, Rc<Cell<u64>>) {
        let bytes = Rc::new(Cell::new(0));
        (
            Counting {
                data,
                bytes: bytes.clone(),
                broken: Rc::new(Cell::new(false)),
            },
            bytes,
        )
    }
}
impl Source for Counting {
    fn len(&self) -> u64 {
        self.data.len() as u64
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<()> {
        if self.broken.get() {
            return Err(Error::Io("test: the file became unreadable".into()));
        }
        self.bytes.set(self.bytes.get() + buf.len() as u64);
        SliceSource(&self.data).read_at(offset, buf)
    }
}

/// Drains a stream; returns every block and the concatenated bytes.
fn drain<S: Source, E: Source>(stream: &mut ConvertStream<S, E>) -> (Vec<usize>, Vec<u8>) {
    let mut sizes = Vec::new();
    let mut all = Vec::new();
    let mut block = Vec::new();
    while stream.next_block(&mut block).expect("next_block") {
        assert!(
            !block.is_empty(),
            "a block that is not the last one is never empty"
        );
        sizes.push(block.len());
        all.extend_from_slice(&block);
    }
    (sizes, all)
}

fn no_extra_stream(bytes: &[u8]) -> ConvertStream<SliceSource<'_>, EmptySource> {
    let scanned = scan_source(SliceSource(bytes), &mut |_, _| {}).unwrap();
    scanned
        .into_stream(
            SliceSource(bytes),
            EmptySource,
            &[],
            &ConvertOptions::default(),
        )
        .unwrap()
}

#[test]
fn stream_bytes_equal_the_pushed_conversion() {
    let bytes = plain_mkv();
    let (expected, expected_report) = run_convert(&bytes).unwrap();
    let mut stream = no_extra_stream(&bytes);
    assert_eq!(
        stream.report(),
        &expected_report,
        "report is known up front"
    );
    assert_eq!(stream.total_size(), expected.len() as u64);
    let (_, got) = drain(&mut stream);
    assert_eq!(
        got, expected,
        "pull output must be byte-identical to push output"
    );
}

#[test]
fn stream_with_replacement_equals_the_pushed_conversion() {
    let bytes = vorbis_mkv(60, 300);
    let (rep, extra) = aac_replacement(110);
    let mut expected = Vec::new();
    convert_with_replacements(
        SliceSource(&bytes),
        SliceSource(&extra),
        std::slice::from_ref(&rep),
        &mut expected,
        &ConvertOptions::default(),
        &mut |_| {},
    )
    .unwrap();
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    let mut stream = scanned
        .into_stream(
            SliceSource(&bytes),
            SliceSource(&extra),
            std::slice::from_ref(&rep),
            &ConvertOptions::default(),
        )
        .unwrap();
    let (_, got) = drain(&mut stream);
    assert_eq!(got, expected);
    assert!(
        got.windows(extra.len().min(50))
            .any(|w| w == &extra[..w.len()]),
        "the re-encoded packets are in the output"
    );
}

#[test]
fn blocks_are_bounded_even_for_a_huge_sample() {
    // one 3 MiB video sample: it must be copied in slices, never as one 3 MiB block
    let mut frames = vec![Frame::new(1, 0, payload(1, 0, 3 * 1024 * 1024 + 17), true)];
    for i in 1..4usize {
        frames.push(Frame::new(1, i as i64 * 40, payload(1, i, 500), i == 0));
    }
    let bytes = build_mkv(&[avc_track()], &frames, &MkvOpts::default());
    let mut stream = no_extra_stream(&bytes);
    let total = stream.total_size();
    let (sizes, got) = drain(&mut stream);
    assert_eq!(got.len() as u64, total);
    let header = sizes[0];
    assert!(
        header < 64 * 1024,
        "first block is only the header: {header}"
    );
    let payload_max = sizes[1..].iter().copied().max().unwrap();
    assert!(
        payload_max <= 2 << 20,
        "largest payload block {payload_max} exceeds 2 MiB"
    );
    assert!(sizes.len() >= 4, "{} blocks", sizes.len());
}

#[test]
fn fraction_is_monotone_from_zero_to_one() {
    let bytes = vorbis_mkv(200, 20_000);
    let (rep, extra) = aac_replacement(400);
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    let mut stream = scanned
        .into_stream(
            SliceSource(&bytes),
            SliceSource(&extra),
            std::slice::from_ref(&rep),
            &ConvertOptions::default(),
        )
        .unwrap();
    assert_eq!(stream.fraction(), 0.0);
    let mut last = 0.0;
    let mut block = Vec::new();
    let mut steps = 0;
    while stream.next_block(&mut block).unwrap() {
        let f = stream.fraction();
        assert!((0.0..=1.0).contains(&f) && f >= last, "{f} after {last}");
        last = f;
        steps += 1;
    }
    assert_eq!(stream.fraction(), 1.0);
    assert!(steps > 2);
}

#[test]
fn after_the_end_next_block_keeps_returning_false() {
    let bytes = plain_mkv();
    let mut stream = no_extra_stream(&bytes);
    drain(&mut stream);
    let mut block = vec![1, 2, 3];
    for _ in 0..3 {
        assert!(!stream.next_block(&mut block).unwrap());
        assert!(
            block.is_empty(),
            "the buffer is cleared when there is nothing left"
        );
    }
}

#[test]
fn an_unreadable_file_is_an_error_not_a_panic() {
    // larger than the 4 MiB read window, so later blocks must really read the file again
    let bytes = vorbis_mkv(400, 20_000);
    assert!(bytes.len() > 6 << 20);
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    let (src, _) = Counting::new(bytes.clone());
    let broken = src.broken.clone();
    let mut stream = scanned
        .into_stream(src, EmptySource, &[], &ConvertOptions::default())
        .unwrap();
    let mut block = Vec::new();
    // the header and the first payload blocks are fine; then the file (say, a moved or
    // unplugged drive) can no longer be read
    assert!(stream.next_block(&mut block).unwrap());
    assert!(stream.next_block(&mut block).unwrap());
    broken.set(true);
    let err = loop {
        match stream.next_block(&mut block) {
            Ok(true) => continue,
            Ok(false) => panic!("the read failure was swallowed"),
            Err(e) => break e,
        }
    };
    assert!(matches!(err, Error::Io(_)), "{err:?}");
}

#[test]
fn the_size_limit_is_checked_before_any_block() {
    let bytes = plain_mkv();
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    let err = scanned
        .into_stream(
            SliceSource(&bytes),
            EmptySource,
            &[],
            &ConvertOptions {
                max_output_bytes: Some(100),
            },
        )
        .err()
        .expect("must fail");
    assert!(matches!(err, Error::TooLarge(_)), "{err:?}");
}

#[test]
fn a_tiny_video_only_file_streams() {
    let frames = vec![Frame::new(1, 0, payload(1, 0, 100), true)];
    let bytes = build_mkv(&[avc_track()], &frames, &MkvOpts::default());
    let (expected, _) = run_convert(&bytes).unwrap();
    let mut stream = no_extra_stream(&bytes);
    let (sizes, got) = drain(&mut stream);
    assert_eq!(got, expected);
    assert!(sizes.len() >= 2, "header block, then payload: {sizes:?}");
}

#[test]
fn replacement_audio_does_not_make_the_file_be_read_over_and_over() {
    // A fixed 4 MiB window over (file + re-encoded audio) was evicted at every switch between
    // the video in the file and the audio far past its end: a 228 MB file cost 5.4 GB of reads.
    let bytes = vorbis_mkv(500, 20_000); // about 10 MB of video
    assert!(bytes.len() > 9_000_000, "{}", bytes.len());
    let (rep, extra) = aac_replacement(1000);
    let limit = bytes.len() as u64 * 13 / 10;

    // pull API
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    let (src, counter) = Counting::new(bytes.clone());
    let mut stream = scanned
        .into_stream(
            src,
            SliceSource(&extra),
            std::slice::from_ref(&rep),
            &ConvertOptions::default(),
        )
        .unwrap();
    drain(&mut stream);
    assert!(
        counter.get() <= limit,
        "stream read {} bytes of a {} byte file",
        counter.get(),
        bytes.len()
    );

    // push API (same fix)
    let (src, counter) = Counting::new(bytes.clone());
    let mut out = Vec::new();
    let scanned = scan_source(SliceSource(&bytes), &mut |_, _| {}).unwrap();
    scanned
        .convert(
            src,
            SliceSource(&extra),
            std::slice::from_ref(&rep),
            &mut out,
            &ConvertOptions::default(),
            &mut |_| {},
        )
        .unwrap();
    assert!(
        counter.get() <= limit,
        "convert read {} bytes of a {} byte file",
        counter.get(),
        bytes.len()
    );
}

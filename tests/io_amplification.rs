mod common;
use common::*;
use mkv2mp4::convert::{convert, ConvertOptions};
use mkv2mp4::error::Result;
use mkv2mp4::source::Source;
use std::cell::Cell;
use std::rc::Rc;

struct CountSrc<'a> {
    data: &'a [u8],
    bytes: Rc<Cell<u64>>,
    calls: Rc<Cell<u64>>,
    max_read: Rc<Cell<usize>>,
}
impl Source for CountSrc<'_> {
    fn len(&self) -> u64 {
        self.data.len() as u64
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<()> {
        let o = offset as usize;
        if o + buf.len() > self.data.len() {
            return Err(mkv2mp4::error::Error::Io("range".into()));
        }
        buf.copy_from_slice(&self.data[o..o + buf.len()]);
        self.bytes.set(self.bytes.get() + buf.len() as u64);
        self.calls.set(self.calls.get() + 1);
        self.max_read.set(self.max_read.get().max(buf.len()));
        Ok(())
    }
}

fn big_file(codec: &str, private: Vec<u8>, frame_len: usize, wrap_nal: bool) -> Vec<u8> {
    let mut v = TrackSpec::video(1, codec, private, 320, 240);
    v.default_duration_ns = Some(41_666_667);
    let a = TrackSpec::audio(2, "A_AAC", ASC_LC_48K_STEREO.to_vec(), 48000.0, 2);
    let mut frames = Vec::new();
    for i in 0..40usize {
        let mut d = payload(1, i, frame_len);
        if wrap_nal {
            d = hevc_nal(if i % 10 == 0 { 19 } else { 1 }, &d);
        }
        frames.push(Frame::new(1, (i as i64) * 42, d, i % 10 == 0));
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
    build_mkv(
        &[v, a],
        &frames,
        &MkvOpts {
            frames_per_cluster: 20,
            ..Default::default()
        },
    )
}

fn measure(bytes: &[u8]) -> (u64, u64, usize, u64) {
    let (b, c, m) = (
        Rc::new(Cell::new(0)),
        Rc::new(Cell::new(0)),
        Rc::new(Cell::new(0)),
    );
    let src = CountSrc {
        data: bytes,
        bytes: b.clone(),
        calls: c.clone(),
        max_read: m.clone(),
    };
    let mut out = Vec::new();
    convert(src, &mut out, &ConvertOptions::default(), &mut |_| {}).unwrap();
    (b.get(), c.get(), m.get(), out.len() as u64)
}

#[test]
fn h264_read_amplification_is_small_for_large_frames() {
    let file = big_file("V_MPEG4/ISO/AVC", AVCC.to_vec(), 200_000, false);
    let (read, calls, max_read, _) = measure(&file);
    let ratio = read as f64 / file.len() as f64;
    assert!(
        ratio <= 1.35,
        "read amplification {ratio:.2}x ({read} bytes read of {} in {calls} calls)",
        file.len()
    );
    assert!(
        max_read <= 4 << 20,
        "no single read larger than the 4 MiB write window, got {max_read}"
    );
}

#[test]
fn hevc_read_amplification_stays_below_two() {
    let file = big_file("V_MPEGH/ISO/HEVC", hvcc_complete(), 200_000, true);
    let (read, calls, _, _) = measure(&file);
    let ratio = read as f64 / file.len() as f64;
    assert!(
        ratio <= 1.6,
        "read amplification {ratio:.2}x ({read} bytes read of {} in {calls} calls)",
        file.len()
    );
}

#[test]
fn small_frames_are_read_sequentially_without_pathological_call_counts() {
    let file = big_file("V_MPEG4/ISO/AVC", AVCC.to_vec(), 2_000, false);
    let (read, calls, _, _) = measure(&file);
    assert!(read as f64 / file.len() as f64 <= 2.2);
    assert!(calls < 2_000, "{calls} read calls for {} bytes", file.len());
}

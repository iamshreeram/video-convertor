//! Byte-source and byte-sink abstractions, plus the in-memory and windowed implementations.

use crate::error::{Error, Result};

/// Random-access read-only input. `read_at` fills `buf` completely or fails.
pub trait Source {
    fn len(&self) -> u64;
    /// Provided: true when `len() == 0` (satisfies clippy's `len_without_is_empty`).
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Fills `buf` with the bytes at `offset..offset + buf.len()`.
    /// Returns `Err(Error::Io)` if the range is outside `0..len()`.
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<()>;
}

/// Append-only output.
pub trait Sink {
    fn write(&mut self, data: &[u8]) -> Result<()>;
}

/// A `Source` over an in-memory byte slice.
pub struct SliceSource<'a>(pub &'a [u8]);

impl Source for SliceSource<'_> {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<()> {
        let end = offset
            .checked_add(buf.len() as u64)
            .ok_or_else(|| Error::Io("read range overflows".into()))?;
        if end > self.len() {
            return Err(Error::Io(format!(
                "read of {} bytes at offset {} is past end of {} byte input",
                buf.len(),
                offset,
                self.len()
            )));
        }
        // Both bounds were checked above, so `get` cannot fail; keep it fallible anyway.
        let start = offset as usize;
        let src = self
            .0
            .get(start..start + buf.len())
            .ok_or_else(|| Error::Io("slice bounds".into()))?;
        buf.copy_from_slice(src);
        Ok(())
    }
}

/// A mutably borrowed source is itself a source, so wrappers can borrow without owning.
impl<S: Source + ?Sized> Source for &mut S {
    fn len(&self) -> u64 {
        (**self).len()
    }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<()> {
        (**self).read_at(offset, buf)
    }
}

impl Sink for Vec<u8> {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        self.try_reserve(data.len())
            .map_err(|_| Error::TooLarge("output buffer allocation failed".into()))?;
        self.extend_from_slice(data);
        Ok(())
    }
}

/// Wraps a `Source` with a read-ahead window so that many small reads hit one large read.
///
/// Reads at least as long as the current window bypass the cache. Smaller reads are served
/// from the cached window when fully contained in it, otherwise the window is refilled
/// starting at the requested offset. With an adaptive window, the window grows while reading
/// proceeds sequentially and resets to its minimum after a jump. Output is byte-identical to
/// the inner source for any window sizes.
pub struct BufferedSource<S: Source> {
    inner: S,
    min_window: usize,
    max_window: usize,
    /// Requested length of the most recent refill (the current window length).
    window: usize,
    cache: Vec<u8>,
    win_start: u64,
    win_len: usize,
}

impl<S: Source> BufferedSource<S> {
    /// Fixed window of `window` bytes. `window` is clamped to at least 1 byte.
    pub fn new(inner: S, window: usize) -> Self {
        Self::new_adaptive(inner, window, window)
    }

    /// Adaptive window: starts at `min_window`, doubles up to `max_window` on sequential
    /// continuation, and resets to `min_window` on a jump. `min_window` is clamped to at
    /// least 1 byte and `max_window` to at least `min_window`.
    pub fn new_adaptive(inner: S, min_window: usize, max_window: usize) -> Self {
        let min_window = min_window.max(1);
        let max_window = max_window.max(min_window);
        BufferedSource {
            inner,
            min_window,
            max_window,
            window: min_window,
            cache: vec![0u8; max_window],
            win_start: 0,
            win_len: 0,
        }
    }
}

impl<S: Source> Source for BufferedSource<S> {
    fn len(&self) -> u64 {
        self.inner.len()
    }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<()> {
        let end = offset
            .checked_add(buf.len() as u64)
            .ok_or_else(|| Error::Io("read range overflows".into()))?;
        if end > self.len() {
            return Err(Error::Io(format!(
                "read of {} bytes at offset {} is past end of {} byte input",
                buf.len(),
                offset,
                self.len()
            )));
        }
        if buf.is_empty() {
            return Ok(());
        }
        if buf.len() >= self.window {
            return self.inner.read_at(offset, buf);
        }
        let win_end = self.win_start.saturating_add(self.win_len as u64);
        if self.win_len > 0 && offset >= self.win_start && end <= win_end {
            let rel = (offset - self.win_start) as usize;
            let src = self
                .cache
                .get(rel..rel + buf.len())
                .ok_or_else(|| Error::Io("window bounds".into()))?;
            buf.copy_from_slice(src);
            return Ok(());
        }
        // Refill. A miss that continues the sequential stream (offset at most one previous
        // window length past the window end) doubles the window; any other miss resets it.
        let continues = self.win_len > 0
            && offset >= self.win_start
            && offset <= win_end.saturating_add(self.window as u64);
        let next = if continues {
            self.window.saturating_mul(2).min(self.max_window)
        } else {
            self.min_window
        };
        // Fill: up to half the window precedes `offset` (so small backward steps, such as
        // interleaved tracks, stay cached), the window never ends before the read does, and it
        // is bounded by the input end.
        let want = next.max(buf.len());
        let back = (want / 2)
            .min(want - buf.len())
            .min(usize::try_from(offset).unwrap_or(usize::MAX));
        let start = offset - back as u64;
        let fill = (self.len() - start).min(want as u64) as usize;
        let old_start = self.win_start;
        let old_len = self.win_len;
        let old_end = win_end;
        self.window = next;
        self.win_len = 0;
        // Bytes already cached that fall inside the new window are moved, not read again.
        let new_end = start + fill as u64;
        let keep_lo = start.max(old_start);
        let keep_hi = new_end.min(old_end);
        if old_len > 0 && keep_lo < keep_hi {
            let n = (keep_hi - keep_lo) as usize;
            let from = (keep_lo - old_start) as usize;
            let to = (keep_lo - start) as usize;
            let tail = (keep_hi - start) as usize;
            if from + n > old_len || to + n > fill {
                return Err(Error::Io("window bounds".into()));
            }
            self.cache.copy_within(from..from + n, to);
            read_span(&mut self.inner, &mut self.cache, start, 0, to)?;
            read_span(&mut self.inner, &mut self.cache, keep_hi, tail, fill - tail)?;
        } else {
            read_span(&mut self.inner, &mut self.cache, start, 0, fill)?;
        }
        self.win_start = start;
        self.win_len = fill;
        let rel = (offset - start) as usize;
        let src = self
            .cache
            .get(rel..rel + buf.len())
            .ok_or_else(|| Error::Io("window bounds".into()))?;
        buf.copy_from_slice(src);
        Ok(())
    }
}

/// Reads `len` bytes at file offset `file_off` into `cache[at..at + len]`.
fn read_span<S: Source>(
    inner: &mut S,
    cache: &mut [u8],
    file_off: u64,
    at: usize,
    len: usize,
) -> Result<()> {
    if len == 0 {
        return Ok(());
    }
    let dst = cache
        .get_mut(at..at + len)
        .ok_or_else(|| Error::Io("window bounds".into()))?;
    inner.read_at(file_off, dst)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Small deterministic LCG so the test needs no dependencies.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0 >> 33
        }
    }

    fn data() -> Vec<u8> {
        (0..5000u32)
            .map(|i| (i.wrapping_mul(31) ^ (i >> 3)) as u8)
            .collect()
    }

    /// Counts inner reads and records the largest one.
    struct CountingSrc<'a> {
        data: &'a [u8],
        reads: usize,
        max_read: usize,
    }

    impl Source for CountingSrc<'_> {
        fn len(&self) -> u64 {
            self.data.len() as u64
        }

        fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<()> {
            self.reads += 1;
            self.max_read = self.max_read.max(buf.len());
            SliceSource(self.data).read_at(offset, buf)
        }
    }

    #[test]
    fn buffered_matches_slice_for_random_reads_and_windows() {
        let bytes = data();
        for window in [1usize, 3, 64, 1 << 20] {
            let mut rng = Lcg(0x9E37_79B9 + window as u64);
            let mut reference = SliceSource(&bytes);
            let mut buffered = BufferedSource::new(SliceSource(&bytes), window);
            assert_eq!(buffered.len(), bytes.len() as u64);
            for _ in 0..200 {
                let offset = rng.next() % bytes.len() as u64;
                let max_len = (bytes.len() as u64 - offset).min(300);
                let len = (rng.next() % (max_len + 1)) as usize;
                let mut a = vec![0u8; len];
                let mut b = vec![0u8; len];
                reference.read_at(offset, &mut a).unwrap();
                buffered.read_at(offset, &mut b).unwrap();
                assert_eq!(a, b, "window {window} offset {offset} len {len}");
            }
        }
    }

    #[test]
    fn adaptive_matches_slice_for_random_reads() {
        let bytes: Vec<u8> = (0..200_000u32)
            .map(|i| (i.wrapping_mul(131) ^ (i >> 5)) as u8)
            .collect();
        for (min, max) in [(1usize, 1usize), (1, 8), (4, 64), (4096, 1 << 20)] {
            let mut rng = Lcg(0xC0FF_EE00 + (min * 7 + max) as u64);
            let mut reference = SliceSource(&bytes);
            let mut buffered = BufferedSource::new_adaptive(SliceSource(&bytes), min, max);
            for _ in 0..3000 {
                let offset = rng.next() % bytes.len() as u64;
                let remaining = bytes.len() as u64 - offset;
                let cap = if rng.next() % 2 == 0 { 64 } else { 9000 };
                let len = (rng.next() % (remaining.min(cap) + 1)) as usize;
                let mut a = vec![0u8; len];
                let mut b = vec![0u8; len];
                reference.read_at(offset, &mut a).unwrap();
                buffered.read_at(offset, &mut b).unwrap();
                assert_eq!(a, b, "min {min} max {max} offset {offset} len {len}");
            }
        }
    }

    #[test]
    fn adaptive_sequential_small_reads_need_few_inner_reads() {
        let bytes: Vec<u8> = (0..160_000u32).map(|i| (i % 251) as u8).collect();
        let mut counter = CountingSrc {
            data: &bytes,
            reads: 0,
            max_read: 0,
        };
        let mut out = Vec::with_capacity(bytes.len());
        {
            let mut buffered = BufferedSource::new_adaptive(&mut counter, 4096, 1 << 20);
            for i in 0..10_000u64 {
                let mut buf = [0u8; 16];
                buffered.read_at(i * 16, &mut buf).unwrap();
                out.extend_from_slice(&buf);
            }
        }
        assert_eq!(out, bytes);
        assert!(counter.reads <= 20, "{} inner reads", counter.reads);
    }

    #[test]
    fn adaptive_jumps_refill_at_minimum_window() {
        let bytes: Vec<u8> = vec![7u8; 10_000_000];
        let mut counter = CountingSrc {
            data: &bytes,
            reads: 0,
            max_read: 0,
        };
        {
            let mut buffered = BufferedSource::new_adaptive(&mut counter, 4096, 1 << 20);
            for k in 0..100u64 {
                let mut buf = [0u8; 8];
                buffered.read_at(k * 100_000, &mut buf).unwrap();
                assert_eq!(buf, [7u8; 8]);
            }
        }
        assert_eq!(counter.reads, 100, "one inner read per jump");
        assert!(
            counter.max_read <= 4096,
            "max inner read {}",
            counter.max_read
        );
    }

    #[test]
    fn mut_ref_source_delegates() {
        let bytes = data();
        let mut slice = SliceSource(&bytes);
        let mut by_ref: &mut SliceSource = &mut slice;
        assert_eq!(Source::len(&by_ref), bytes.len() as u64);
        let mut buf = [0u8; 4];
        Source::read_at(&mut by_ref, 100, &mut buf).unwrap();
        assert_eq!(&buf[..], &bytes[100..104]);
    }

    #[test]
    fn read_past_end_is_io_error() {
        let bytes = data();
        let mut slice = SliceSource(&bytes);
        let mut buffered = BufferedSource::new(SliceSource(&bytes), 64);
        let mut buf = [0u8; 4];
        let past = bytes.len() as u64 - 2;
        assert!(matches!(slice.read_at(past, &mut buf), Err(Error::Io(_))));
        assert!(matches!(
            buffered.read_at(past, &mut buf),
            Err(Error::Io(_))
        ));
        assert!(matches!(
            slice.read_at(u64::MAX, &mut buf),
            Err(Error::Io(_))
        ));
        assert!(matches!(
            buffered.read_at(u64::MAX, &mut buf),
            Err(Error::Io(_))
        ));
    }

    #[test]
    fn empty_read_at_end_is_ok() {
        let bytes = data();
        let mut slice = SliceSource(&bytes);
        let mut buffered = BufferedSource::new(SliceSource(&bytes), 8);
        let end = bytes.len() as u64;
        assert!(slice.read_at(end, &mut []).is_ok());
        assert!(buffered.read_at(end, &mut []).is_ok());
    }

    #[test]
    fn zero_window_is_clamped_to_one() {
        let bytes = data();
        let mut buffered = BufferedSource::new(SliceSource(&bytes), 0);
        let mut buf = [0u8; 3];
        buffered.read_at(10, &mut buf).unwrap();
        assert_eq!(&buf[..], &bytes[10..13]);
    }

    #[test]
    fn vec_sink_appends() {
        let mut out: Vec<u8> = Vec::new();
        out.write(b"ab").unwrap();
        out.write(b"cd").unwrap();
        assert_eq!(out, b"abcd");
    }
}

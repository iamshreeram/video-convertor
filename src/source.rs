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
/// Reads at least `window` bytes long bypass the cache. Smaller reads are served from the
/// cached window when fully contained in it, otherwise the window is refilled starting at
/// the requested offset. Output is byte-identical to the inner source for any window size.
pub struct BufferedSource<S: Source> {
    inner: S,
    window: usize,
    cache: Vec<u8>,
    win_start: u64,
    win_len: usize,
}

impl<S: Source> BufferedSource<S> {
    /// `window` is clamped to at least 1 byte.
    pub fn new(inner: S, window: usize) -> Self {
        let window = window.max(1);
        BufferedSource {
            inner,
            window,
            cache: vec![0u8; window],
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
        // Refill: window starts at `offset`, length bounded by the window and the input end.
        let remaining = self.len() - offset;
        let fill = remaining.min(self.window as u64) as usize;
        self.win_len = 0;
        let dst = self
            .cache
            .get_mut(..fill)
            .ok_or_else(|| Error::Io("window bounds".into()))?;
        self.inner.read_at(offset, dst)?;
        self.win_start = offset;
        self.win_len = fill;
        buf.copy_from_slice(&self.cache[..buf.len()]);
        Ok(())
    }
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

//! Matroska/WebM EBML primitives: element headers, size/track vints and
//! big-endian integer/float decoding. Pure functions over byte slices; no I/O.

use crate::error::{Error, Result};

/// Longest possible element header: 4-byte ID + 8-byte size.
pub const MAX_HEADER_LEN: usize = 12;

/// A decoded variable-length integer (element size or track number).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Vint {
    /// Value with the length-marker bit removed.
    pub value: u64,
    /// Encoded length in bytes (1..=8).
    pub len: usize,
    /// True when every value bit is set (the "unknown size" marker).
    pub unknown: bool,
}

/// A parsed element header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    /// Element ID with its length-marker bits kept, e.g. `0x1F43B675`.
    pub id: u32,
    /// Payload size in bytes; `None` when the size is unknown.
    pub size: Option<u64>,
    /// Header length in bytes (ID bytes + size bytes).
    pub len: usize,
}

fn invalid(msg: &str) -> Error {
    Error::InvalidMkv(msg.to_string())
}

/// Encoded length from the leading-zero count of the first byte; `None` for 0x00.
fn lead_len(first: u8) -> Option<usize> {
    if first == 0 {
        None
    } else {
        Some(first.leading_zeros() as usize + 1)
    }
}

/// Decodes a size or track-number vint from the start of `buf`.
///
/// `Ok(None)` means `buf` is too short to hold the whole vint; `Err` means the
/// first byte is invalid (0x00).
pub fn parse_vint(buf: &[u8]) -> Result<Option<Vint>> {
    let Some(&first) = buf.first() else {
        return Ok(None);
    };
    let len = lead_len(first).ok_or_else(|| invalid("invalid EBML size or track number"))?;
    let Some(bytes) = buf.get(..len) else {
        return Ok(None);
    };
    let raw = bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b));
    let all_ones = (1u64 << (7 * len)) - 1;
    let value = raw & all_ones;
    Ok(Some(Vint {
        value,
        len,
        unknown: value == all_ones,
    }))
}

/// Decodes an element header from the start of `buf`.
///
/// `Ok(None)` means `buf` ends before the header is complete. `Err` means the
/// ID is invalid (first byte 0x00 or an ID longer than 4 bytes) or the size
/// vint's first byte is 0x00.
pub fn parse_header(buf: &[u8]) -> Result<Option<Header>> {
    let Some(&first) = buf.first() else {
        return Ok(None);
    };
    let id_len = match lead_len(first) {
        Some(n) if n <= 4 => n,
        _ => return Err(invalid("invalid EBML element ID")),
    };
    let Some(id_bytes) = buf.get(..id_len) else {
        return Ok(None);
    };
    let id = id_bytes
        .iter()
        .fold(0u32, |acc, b| (acc << 8) | u32::from(*b));
    let Some(rest) = buf.get(id_len..) else {
        return Ok(None);
    };
    let Some(size) = parse_vint(rest)? else {
        return Ok(None);
    };
    Ok(Some(Header {
        id,
        size: if size.unknown { None } else { Some(size.value) },
        len: id_len + size.len,
    }))
}

/// Big-endian unsigned integer of 0..=8 bytes (empty means 0).
pub fn uint_value(bytes: &[u8]) -> Result<u64> {
    if bytes.len() > 8 {
        return Err(invalid("integer element longer than 8 bytes"));
    }
    Ok(bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b)))
}

/// Big-endian two's-complement integer of 0..=8 bytes, sign-extended (empty means 0).
pub fn sint_value(bytes: &[u8]) -> Result<i64> {
    let n = bytes.len();
    if n == 0 {
        return Ok(0);
    }
    let raw = uint_value(bytes)?;
    let shift = 64 - 8 * n as u32;
    Ok(((raw << shift) as i64) >> shift)
}

/// Big-endian IEEE float of exactly 4 or 8 bytes.
pub fn float_value(bytes: &[u8]) -> Result<f64> {
    match bytes.len() {
        4 => {
            let mut b = [0u8; 4];
            b.copy_from_slice(bytes);
            Ok(f64::from(f32::from_be_bytes(b)))
        }
        8 => {
            let mut b = [0u8; 8];
            b.copy_from_slice(bytes);
            Ok(f64::from_be_bytes(b))
        }
        _ => Err(invalid("float element must be 4 or 8 bytes")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_keep_marker_bits() {
        let h = parse_header(&[0x1A, 0x45, 0xDF, 0xA3, 0x81])
            .unwrap()
            .unwrap();
        assert_eq!((h.id, h.size, h.len), (0x1A45_DFA3, Some(1), 5));
        let h = parse_header(&[0xEC, 0x80]).unwrap().unwrap();
        assert_eq!((h.id, h.size, h.len), (0xEC, Some(0), 2));
    }

    #[test]
    fn unknown_sizes_are_none() {
        let seg = [
            0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        ];
        let h = parse_header(&seg).unwrap().unwrap();
        assert_eq!((h.id, h.size, h.len), (0x1853_8067, None, 12));
        let h = parse_header(&[0xA3, 0xFF]).unwrap().unwrap();
        assert_eq!((h.size, h.len), (None, 2));
        let v = parse_vint(&[0x40, 0xFF]).unwrap().unwrap();
        assert_eq!((v.value, v.len, v.unknown), (0xFF, 2, false));
        let v = parse_vint(&[0xFF]).unwrap().unwrap();
        assert_eq!((v.value, v.len, v.unknown), (0x7F, 1, true));
    }

    #[test]
    fn eight_byte_sizes_decode() {
        let h = parse_header(&[0xA3, 0x01, 0, 0, 0, 0, 0, 0x01, 0x23])
            .unwrap()
            .unwrap();
        assert_eq!((h.size, h.len), (Some(0x123), 9));
        let v = parse_vint(&[0x01, 0, 0, 0, 0, 0, 0, 0x05])
            .unwrap()
            .unwrap();
        assert_eq!((v.value, v.len, v.unknown), (5, 8, false));
        let v = parse_vint(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE])
            .unwrap()
            .unwrap();
        assert_eq!((v.value, v.unknown), ((1u64 << 56) - 2, false));
        let v = parse_vint(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
            .unwrap()
            .unwrap();
        assert!(v.unknown, "all-ones 8-byte size is unknown");
    }

    #[test]
    fn invalid_first_bytes_are_errors() {
        assert!(parse_header(&[0x00, 0x80]).is_err(), "zero ID byte");
        assert!(parse_header(&[0x08, 0x00]).is_err(), "5-byte ID");
        assert!(parse_header(&[0xA3, 0x00]).is_err(), "zero size byte");
        assert!(parse_vint(&[0x00]).is_err());
    }

    #[test]
    fn short_buffers_are_incomplete() {
        assert_eq!(parse_header(&[]).unwrap(), None);
        assert_eq!(parse_header(&[0x1A, 0x45]).unwrap(), None);
        assert_eq!(parse_header(&[0xA3]).unwrap(), None);
        assert_eq!(parse_header(&[0x40, 0x00]).unwrap(), None);
        assert_eq!(parse_vint(&[]).unwrap(), None);
        assert_eq!(parse_vint(&[0x40]).unwrap(), None);
    }

    #[test]
    fn integer_and_float_decoding() {
        assert_eq!(uint_value(&[]).unwrap(), 0);
        assert_eq!(uint_value(&[0x01, 0x00]).unwrap(), 256);
        assert_eq!(uint_value(&[0xFF; 8]).unwrap(), u64::MAX);
        assert!(uint_value(&[0; 9]).is_err());

        assert_eq!(sint_value(&[]).unwrap(), 0);
        assert_eq!(sint_value(&[0x7F]).unwrap(), 127);
        assert_eq!(sint_value(&[0xFF]).unwrap(), -1);
        assert_eq!(sint_value(&[0xFF, 0xFE]).unwrap(), -2);
        assert_eq!(sint_value(&[0x80, 0, 0, 0, 0, 0, 0, 0]).unwrap(), i64::MIN);
        assert!(sint_value(&[0; 9]).is_err());

        assert_eq!(float_value(&1.5f32.to_be_bytes()).unwrap(), 1.5);
        assert_eq!(float_value(&(-2.25f64).to_be_bytes()).unwrap(), -2.25);
        assert!(float_value(&[0; 3]).is_err());
    }
}

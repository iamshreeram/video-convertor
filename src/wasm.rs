//! wasm-bindgen exports. Only compiled for the wasm32 target (see `lib.rs`).
//!
//! The JavaScript side supplies three callbacks:
//! - `read(offset, length) -> Uint8Array` must return exactly `length` bytes;
//! - `write(chunk: Uint8Array)` receives a copy of each output chunk;
//! - `progress(fraction: number)` is informational; its exceptions are ignored.

use wasm_bindgen::prelude::*;

use crate::convert::{convert, ConvertOptions};
use crate::error::{Error, Result as CrateResult};
use crate::json::report_to_json;
use crate::source::{Sink, Source};

/// Largest integer that an f64 represents exactly (2^53).
const MAX_SAFE_FILE_SIZE: f64 = 9_007_199_254_740_992.0;

/// Crate version, e.g. "0.1.0".
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Converts an MKV file (accessed through JS callbacks) to MP4.
///
/// `max_output_bytes` <= 0 or non-finite means unlimited.
/// Returns the JSON summary; errors are surfaced as their display text.
#[wasm_bindgen]
pub fn convert_mkv_to_mp4(
    file_size: f64,
    max_output_bytes: f64,
    read: &js_sys::Function,
    write: &js_sys::Function,
    progress: &js_sys::Function,
) -> Result<String, JsError> {
    if !file_size.is_finite() || !(0.0..=MAX_SAFE_FILE_SIZE).contains(&file_size) {
        return Err(JsError::new("invalid file size"));
    }
    let max_output = if max_output_bytes.is_finite() && max_output_bytes > 0.0 {
        Some(max_output_bytes as u64)
    } else {
        None
    };
    let source = JsSource {
        len: file_size as u64,
        read: read.clone(),
    };
    let mut sink = JsSink {
        write: write.clone(),
    };
    let options = ConvertOptions {
        max_output_bytes: max_output,
    };
    let mut report_progress = |fraction: f64| {
        // Progress is informational only; a throwing callback must not abort the conversion.
        let _ = progress.call1(&JsValue::NULL, &JsValue::from_f64(fraction));
    };
    match convert(source, &mut sink, &options, &mut report_progress) {
        Ok(report) => Ok(report_to_json(&report)),
        Err(e) => Err(JsError::new(&e.to_string())),
    }
}

/// Extracts a human-readable message from a thrown JS value.
fn js_message(value: &JsValue) -> String {
    if value.is_instance_of::<js_sys::Error>() {
        if let Some(message) = js_sys::Reflect::get(value, &JsValue::from_str("message"))
            .ok()
            .and_then(|m| m.as_string())
        {
            return message;
        }
    }
    if let Some(text) = value.as_string() {
        return text;
    }
    "JavaScript exception".to_string()
}

/// A `Source` backed by the JS `read(offset, length)` callback.
struct JsSource {
    len: u64,
    read: js_sys::Function,
}

impl Source for JsSource {
    fn len(&self) -> u64 {
        self.len
    }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> CrateResult<()> {
        if buf.is_empty() {
            return Ok(());
        }
        let in_bounds =
            matches!(offset.checked_add(buf.len() as u64), Some(end) if end <= self.len);
        if !in_bounds {
            return Err(Error::Io("read past end of input".into()));
        }
        let result = self
            .read
            .call2(
                &JsValue::NULL,
                &JsValue::from_f64(offset as f64),
                &JsValue::from_f64(buf.len() as f64),
            )
            .map_err(|e| Error::Io(js_message(&e)))?;
        if !result.is_instance_of::<js_sys::Uint8Array>()
            && !result.is_instance_of::<js_sys::ArrayBuffer>()
        {
            return Err(Error::Io("read did not return a Uint8Array".into()));
        }
        let bytes = js_sys::Uint8Array::new(&result);
        if u64::from(bytes.length()) != buf.len() as u64 {
            return Err(Error::Io("read returned wrong length".into()));
        }
        bytes.copy_to(buf);
        Ok(())
    }
}

/// A `Sink` backed by the JS `write(chunk)` callback.
struct JsSink {
    write: js_sys::Function,
}

impl Sink for JsSink {
    fn write(&mut self, data: &[u8]) -> CrateResult<()> {
        // `from` copies the bytes onto the JS heap, so the callee may keep the chunk.
        let chunk = js_sys::Uint8Array::from(data);
        self.write
            .call1(&JsValue::NULL, &chunk)
            .map(|_| ())
            .map_err(|e| Error::Sink(js_message(&e)))
    }
}

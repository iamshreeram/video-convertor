//! wasm-bindgen exports. Only compiled for the wasm32 target (see `lib.rs`).
//!
//! The JavaScript side supplies three callbacks:
//! - `read(offset, length) -> Uint8Array` must return exactly `length` bytes;
//! - `write(chunk: Uint8Array)` receives a copy of each output chunk;
//! - `progress(fraction: number)` is informational; its exceptions are ignored.

use wasm_bindgen::prelude::*;

use crate::convert::{
    convert_with_replacements, export_track_packets, probe_with_replacements, scan_source,
    ConvertOptions, ReplacementSample, Scanned, TrackReplacement,
};
use crate::error::{Error, Result as CrateResult};
use crate::json::{probe_to_json, report_to_json};
use crate::source::EmptySource;
use crate::source::{Sink, Source};

/// Largest integer that an f64 represents exactly (2^53).
const MAX_SAFE_FILE_SIZE: f64 = 9_007_199_254_740_992.0;

/// Validates a JS-supplied file size and converts it to bytes.
fn validated_file_size(file_size: f64) -> Result<u64, JsError> {
    if !file_size.is_finite() || !(0.0..=MAX_SAFE_FILE_SIZE).contains(&file_size) {
        return Err(JsError::new("invalid file size"));
    }
    Ok(file_size as u64)
}

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
    convert_mkv_to_mp4_ex(
        file_size,
        max_output_bytes,
        read,
        write,
        progress,
        &JsValue::NULL,
    )
}

/// [`convert_mkv_to_mp4`] with optional re-encoded audio (`replacement`, see
/// `parse_replacement`); `null`/`undefined` means none.
#[wasm_bindgen]
pub fn convert_mkv_to_mp4_ex(
    file_size: f64,
    max_output_bytes: f64,
    read: &js_sys::Function,
    write: &js_sys::Function,
    progress: &js_sys::Function,
    replacement: &JsValue,
) -> Result<String, JsError> {
    let len = validated_file_size(file_size)?;
    let max_output = if max_output_bytes.is_finite() && max_output_bytes > 0.0 {
        Some(max_output_bytes as u64)
    } else {
        None
    };
    let source = JsSource {
        len,
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
    let (replacements, extra) = parse_replacement(replacement)?;
    match convert_with_replacements(
        source,
        extra,
        &replacements,
        &mut sink,
        &options,
        &mut report_progress,
    ) {
        Ok(report) => Ok(report_to_json(&report)),
        Err(e) => Err(JsError::new(&e.to_string())),
    }
}

/// Probes an MKV file (accessed through JS callbacks) without writing any output.
/// Returns the probe JSON; errors are surfaced as their display text.
#[wasm_bindgen]
pub fn probe_mkv(file_size: f64, read: &js_sys::Function) -> Result<String, JsError> {
    probe_mkv_ex(file_size, read, &JsValue::NULL)
}

/// [`probe_mkv`] with optional re-encoded audio (`replacement`).
#[wasm_bindgen]
pub fn probe_mkv_ex(
    file_size: f64,
    read: &js_sys::Function,
    replacement: &JsValue,
) -> Result<String, JsError> {
    let len = validated_file_size(file_size)?;
    let source = JsSource {
        len,
        read: read.clone(),
    };
    let (replacements, extra) = parse_replacement(replacement)?;
    match probe_with_replacements(source, extra, &replacements) {
        Ok(report) => Ok(probe_to_json(&report)),
        Err(e) => Err(JsError::new(&e.to_string())),
    }
}

/// Streams every packet of one track to `on_packet(ptsNs: number, data: Uint8Array)` and returns
/// `{codecId, codecPrivate: Uint8Array, sampleRate, channels}`. Used to feed the browser's
/// audio decoder (Vorbis), since MP4 cannot hold Vorbis.
#[wasm_bindgen]
pub fn export_audio_track(
    file_size: f64,
    read: &js_sys::Function,
    track_number: f64,
    on_packet: &js_sys::Function,
) -> Result<JsValue, JsError> {
    let len = validated_file_size(file_size)?;
    if !track_number.is_finite() || track_number < 0.0 || track_number > 9_007_199_254_740_991.0 {
        return Err(JsError::new("invalid track number"));
    }
    let source = JsSource {
        len,
        read: read.clone(),
    };
    let mut deliver = |pts_ns: i64, data: &[u8]| -> CrateResult<()> {
        let chunk = js_sys::Uint8Array::from(data);
        on_packet
            .call2(&JsValue::NULL, &JsValue::from_f64(pts_ns as f64), &chunk)
            .map(|_| ())
            .map_err(|e| Error::Sink(js_message(&e)))
    };
    let info = export_track_packets(source, track_number as u64, &mut deliver)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let out = js_sys::Object::new();
    let set = |key: &str, value: JsValue| -> Result<(), JsError> {
        js_sys::Reflect::set(&out, &JsValue::from_str(key), &value)
            .map(|_| ())
            .map_err(|_| JsError::new("could not build the result object"))
    };
    set("codecId", JsValue::from_str(&info.codec_id))?;
    set(
        "codecPrivate",
        js_sys::Uint8Array::from(info.codec_private.as_slice()).into(),
    )?;
    set("sampleRate", JsValue::from_f64(info.sample_rate))?;
    set("channels", JsValue::from_f64(f64::from(info.channels)))?;
    Ok(out.into())
}

/// A scanned MKV file. The scan reads every byte of the input, so the page scans once and then
/// probes, exports audio and converts from this object instead of scanning again.
#[wasm_bindgen]
pub struct Scan {
    file_size: u64,
    scanned: Option<Scanned>,
}

#[wasm_bindgen]
impl Scan {
    /// Scans the file. `progress(fraction)` is informational; its exceptions are ignored.
    #[wasm_bindgen(constructor)]
    pub fn new(
        file_size: f64,
        read: &js_sys::Function,
        progress: &js_sys::Function,
    ) -> Result<Scan, JsError> {
        let len = validated_file_size(file_size)?;
        let source = JsSource {
            len,
            read: read.clone(),
        };
        let mut report = |pos: u64, total: u64| {
            if total > 0 {
                let _ = progress.call1(
                    &JsValue::NULL,
                    &JsValue::from_f64(pos as f64 / total as f64),
                );
            }
        };
        let scanned = scan_source(source, &mut report).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Scan {
            file_size: len,
            scanned: Some(scanned),
        })
    }

    /// Probe JSON, as `probe_mkv_ex`, without scanning again.
    pub fn probe(&self, read: &js_sys::Function, replacement: &JsValue) -> Result<String, JsError> {
        let scanned = self.scanned()?;
        let source = JsSource {
            len: self.file_size,
            read: read.clone(),
        };
        let (replacements, extra) = parse_replacement(replacement)?;
        scanned
            .probe(source, extra, &replacements)
            .map(|r| probe_to_json(&r))
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// As `export_audio_track`, without scanning again.
    pub fn export_audio_track(
        &self,
        read: &js_sys::Function,
        track_number: f64,
        on_packet: &js_sys::Function,
    ) -> Result<JsValue, JsError> {
        let scanned = self.scanned()?;
        if !track_number.is_finite() || track_number < 0.0 || track_number > 9_007_199_254_740_991.0
        {
            return Err(JsError::new("invalid track number"));
        }
        let source = JsSource {
            len: self.file_size,
            read: read.clone(),
        };
        let mut deliver = |pts_ns: i64, data: &[u8]| -> CrateResult<()> {
            let chunk = js_sys::Uint8Array::from(data);
            on_packet
                .call2(&JsValue::NULL, &JsValue::from_f64(pts_ns as f64), &chunk)
                .map(|_| ())
                .map_err(|e| Error::Sink(js_message(&e)))
        };
        let info = scanned
            .export_track_packets(source, track_number as u64, &mut deliver)
            .map_err(|e| JsError::new(&e.to_string()))?;
        export_info_to_js(&info)
    }

    /// As `convert_mkv_to_mp4_ex`, without scanning again. `progress` covers 0..1 of the write
    /// phase only. The scan is used up: later calls fail.
    pub fn convert(
        &mut self,
        max_output_bytes: f64,
        read: &js_sys::Function,
        write: &js_sys::Function,
        progress: &js_sys::Function,
        replacement: &JsValue,
    ) -> Result<String, JsError> {
        let scanned = self
            .scanned
            .take()
            .ok_or_else(|| JsError::new("the scan was already used"))?;
        let max_output = if max_output_bytes.is_finite() && max_output_bytes > 0.0 {
            Some(max_output_bytes as u64)
        } else {
            None
        };
        let source = JsSource {
            len: self.file_size,
            read: read.clone(),
        };
        let mut sink = JsSink {
            write: write.clone(),
        };
        let options = ConvertOptions {
            max_output_bytes: max_output,
        };
        let mut report_progress = |fraction: f64| {
            let _ = progress.call1(&JsValue::NULL, &JsValue::from_f64(fraction));
        };
        let (replacements, extra) = parse_replacement(replacement)?;
        scanned
            .convert(
                source,
                extra,
                &replacements,
                &mut sink,
                &options,
                &mut report_progress,
            )
            .map(|r| report_to_json(&r))
            .map_err(|e| JsError::new(&e.to_string()))
    }
}

impl Scan {
    fn scanned(&self) -> Result<&Scanned, JsError> {
        self.scanned
            .as_ref()
            .ok_or_else(|| JsError::new("the scan was already used"))
    }
}

fn export_info_to_js(info: &crate::convert::TrackExport) -> Result<JsValue, JsError> {
    let out = js_sys::Object::new();
    let set = |key: &str, value: JsValue| -> Result<(), JsError> {
        js_sys::Reflect::set(&out, &JsValue::from_str(key), &value)
            .map(|_| ())
            .map_err(|_| JsError::new("could not build the result object"))
    };
    set("codecId", JsValue::from_str(&info.codec_id))?;
    set(
        "codecPrivate",
        js_sys::Uint8Array::from(info.codec_private.as_slice()).into(),
    )?;
    set("sampleRate", JsValue::from_f64(info.sample_rate))?;
    set("channels", JsValue::from_f64(f64::from(info.channels)))?;
    Ok(out.into())
}

fn field(obj: &JsValue, key: &str) -> Result<JsValue, JsError> {
    js_sys::Reflect::get(obj, &JsValue::from_str(key))
        .map_err(|_| JsError::new(&format!("replacement.{key} is unreadable")))
}

fn number_field(obj: &JsValue, key: &str) -> Result<f64, JsError> {
    field(obj, key)?
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or_else(|| JsError::new(&format!("replacement.{key} must be a finite number")))
}

/// Parses the optional replacement object:
/// `{trackNumber, codecId, codecPrivate: Uint8Array, sampleRate, channels, codecDelayNs|null,
///   sizes: Uint32Array, ptsUs: Float64Array, durUs: Float64Array, extraSize, readExtra(off,len)}`.
fn parse_replacement(value: &JsValue) -> Result<(Vec<TrackReplacement>, ExtraSource), JsError> {
    if value.is_null() || value.is_undefined() {
        return Ok((Vec::new(), ExtraSource::None));
    }
    let codec_id = field(value, "codecId")?
        .as_string()
        .ok_or_else(|| JsError::new("replacement.codecId must be a string"))?;
    let private = field(value, "codecPrivate")?;
    if !private.is_instance_of::<js_sys::Uint8Array>() {
        return Err(JsError::new(
            "replacement.codecPrivate must be a Uint8Array",
        ));
    }
    let sizes = field(value, "sizes")?;
    let pts = field(value, "ptsUs")?;
    let dur = field(value, "durUs")?;
    if !sizes.is_instance_of::<js_sys::Uint32Array>()
        || !pts.is_instance_of::<js_sys::Float64Array>()
        || !dur.is_instance_of::<js_sys::Float64Array>()
    {
        return Err(JsError::new(
            "replacement.sizes/ptsUs/durUs must be Uint32Array/Float64Array/Float64Array",
        ));
    }
    let sizes = js_sys::Uint32Array::new(&sizes).to_vec();
    let pts = js_sys::Float64Array::new(&pts).to_vec();
    let dur = js_sys::Float64Array::new(&dur).to_vec();
    if sizes.len() != pts.len() || sizes.len() != dur.len() {
        return Err(JsError::new("replacement arrays differ in length"));
    }
    let samples = sizes
        .iter()
        .zip(pts.iter().zip(dur.iter()))
        .map(|(size, (p, d))| ReplacementSample {
            size: *size,
            pts_ns: (p * 1000.0).round() as i64,
            duration_ns: (d.max(0.0) * 1000.0).round() as u64,
        })
        .collect();
    let delay = field(value, "codecDelayNs")?
        .as_f64()
        .filter(|d| d.is_finite() && *d >= 0.0)
        .map(|d| d as u64);
    let replacement = TrackReplacement {
        track_number: number_field(value, "trackNumber")? as u64,
        codec_id,
        codec_private: js_sys::Uint8Array::new(&private).to_vec(),
        sample_rate: number_field(value, "sampleRate")?,
        channels: number_field(value, "channels")? as u32,
        codec_delay_ns: delay,
        samples,
    };
    let read_extra = field(value, "readExtra")?
        .dyn_into::<js_sys::Function>()
        .map_err(|_| JsError::new("replacement.readExtra must be a function"))?;
    let extra_len = validated_file_size(number_field(value, "extraSize")?)?;
    Ok((
        vec![replacement],
        ExtraSource::Js(JsSource {
            len: extra_len,
            read: read_extra,
        }),
    ))
}

/// Extra bytes appended after the file: none, or a JS-backed buffer.
enum ExtraSource {
    None,
    Js(JsSource),
}

impl Source for ExtraSource {
    fn len(&self) -> u64 {
        match self {
            ExtraSource::None => EmptySource.len(),
            ExtraSource::Js(s) => s.len(),
        }
    }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> CrateResult<()> {
        match self {
            ExtraSource::None => EmptySource.read_at(offset, buf),
            ExtraSource::Js(s) => s.read_at(offset, buf),
        }
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

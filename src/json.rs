//! Hand-written JSON for the wasm conversion summary (no serde).
//!
//! Compiled only for tests and the wasm32 target (see `lib.rs`), so that the
//! native unit tests below exercise exactly the code the wasm export uses.

use crate::convert::ConvertReport;

/// Escapes `s` for use inside a JSON string literal (without the surrounding quotes).
pub(crate) fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// A quoted, escaped JSON string.
fn json_string(s: &str) -> String {
    format!("\"{}\"", json_escape(s))
}

/// Builds the JSON summary returned by `convert_mkv_to_mp4`.
pub(crate) fn report_to_json(report: &ConvertReport) -> String {
    let warnings = report
        .warnings
        .iter()
        .map(|w| json_string(w))
        .collect::<Vec<_>>()
        .join(",");
    let video = match &report.video_codec {
        Some(codec) => json_string(codec),
        None => "null".to_string(),
    };
    let audio = report
        .audio_codecs
        .iter()
        .map(|c| json_string(c))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"warnings\":[{warnings}],\"videoCodec\":{video},\"audioCodecs\":[{audio}],\"durationMs\":{},\"sampleCount\":{},\"outputSize\":{}}}",
        report.duration_ms, report.sample_count, report.output_size
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_plain_text_is_unchanged() {
        assert_eq!(json_escape("h264 AAC-LC"), "h264 AAC-LC");
        assert_eq!(json_escape(""), "");
    }

    #[test]
    fn escape_quotes_and_backslashes() {
        assert_eq!(json_escape(r#"a"b"#), r#"a\"b"#);
        assert_eq!(json_escape(r"a\b"), r"a\\b");
    }

    #[test]
    fn escape_control_characters() {
        assert_eq!(json_escape("a\nb\rc\td"), r"a\nb\rc\td");
        assert_eq!(json_escape("\u{0}\u{1f}"), r"\u0000\u001f");
        // 0x7f (DEL) is not a JSON control character that must be escaped.
        assert_eq!(json_escape("\u{7f}"), "\u{7f}");
    }

    #[test]
    fn escape_keeps_non_ascii() {
        assert_eq!(json_escape("é€"), "é€");
    }

    #[test]
    fn report_json_full() {
        let report = ConvertReport {
            warnings: vec!["dropped \"x\"".to_string(), "back\\slash".to_string()],
            video_codec: Some("h264".to_string()),
            audio_codecs: vec!["aac".to_string(), "opus".to_string()],
            duration_ms: 1500,
            sample_count: 42,
            output_size: 98765,
        };
        assert_eq!(
            report_to_json(&report),
            r#"{"warnings":["dropped \"x\"","back\\slash"],"videoCodec":"h264","audioCodecs":["aac","opus"],"durationMs":1500,"sampleCount":42,"outputSize":98765}"#
        );
    }

    #[test]
    fn report_json_empty_and_null() {
        let report = ConvertReport {
            warnings: Vec::new(),
            video_codec: None,
            audio_codecs: Vec::new(),
            duration_ms: 0,
            sample_count: 0,
            output_size: 0,
        };
        assert_eq!(
            report_to_json(&report),
            r#"{"warnings":[],"videoCodec":null,"audioCodecs":[],"durationMs":0,"sampleCount":0,"outputSize":0}"#
        );
    }

    #[test]
    fn report_json_escapes_warning_control_chars() {
        let report = ConvertReport {
            warnings: vec!["line1\nline2".to_string()],
            video_codec: None,
            audio_codecs: Vec::new(),
            duration_ms: 1,
            sample_count: 1,
            output_size: 1,
        };
        let json = report_to_json(&report);
        assert!(json.contains(r#""warnings":["line1\nline2"]"#), "{json}");
    }
}

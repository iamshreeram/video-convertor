//! Hand-written JSON for the wasm conversion summary (no serde).
//!
//! Compiled only for tests and the wasm32 target (see `lib.rs`), so that the
//! native unit tests below exercise exactly the code the wasm export uses.

use crate::convert::{ConvertReport, ProbeReport, TrackReport};
use crate::mkv::TrackKind;

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

/// JSON object for one selected track of a probe report.
fn track_json(track: &TrackReport) -> String {
    let kind = match track.kind {
        TrackKind::Video => "video",
        TrackKind::Audio => "audio",
        TrackKind::Other => "other",
    };
    format!(
        "{{\"kind\":\"{kind}\",\"codec\":{},\"width\":{},\"height\":{},\"channels\":{},\"sampleRate\":{},\"language\":{},\"sampleCount\":{}}}",
        json_string(&track.codec),
        track.width,
        track.height,
        track.channels,
        track.sample_rate,
        json_string(&track.language),
        track.sample_count
    )
}

/// Builds the JSON returned by `probe_mkv`.
pub(crate) fn probe_to_json(report: &ProbeReport) -> String {
    let tracks = report
        .tracks
        .iter()
        .map(track_json)
        .collect::<Vec<_>>()
        .join(",");
    let warnings = report
        .warnings
        .iter()
        .map(|w| json_string(w))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"tracks\":[{tracks}],\"durationMs\":{},\"outputSize\":{},\"warnings\":[{warnings}]}}",
        report.duration_ms, report.output_size
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

    fn sample_probe() -> ProbeReport {
        ProbeReport {
            tracks: vec![
                TrackReport {
                    kind: TrackKind::Video,
                    codec: "h264".to_string(),
                    width: 320,
                    height: 240,
                    channels: 0,
                    sample_rate: 0,
                    language: "und".to_string(),
                    sample_count: 24,
                },
                TrackReport {
                    kind: TrackKind::Audio,
                    codec: "aac".to_string(),
                    width: 0,
                    height: 0,
                    channels: 2,
                    sample_rate: 48000,
                    language: "eng".to_string(),
                    sample_count: 47,
                },
            ],
            duration_ms: 1000,
            output_size: 12345,
            warnings: vec!["w\"1".to_string()],
        }
    }

    #[test]
    fn probe_json_audio_and_video_example() {
        assert_eq!(
            probe_to_json(&sample_probe()),
            r#"{"tracks":[{"kind":"video","codec":"h264","width":320,"height":240,"channels":0,"sampleRate":0,"language":"und","sampleCount":24},{"kind":"audio","codec":"aac","width":0,"height":0,"channels":2,"sampleRate":48000,"language":"eng","sampleCount":47}],"durationMs":1000,"outputSize":12345,"warnings":["w\"1"]}"#
        );
    }

    #[test]
    fn probe_json_empty_tracks_and_warnings() {
        let report = ProbeReport {
            tracks: Vec::new(),
            duration_ms: 0,
            output_size: 0,
            warnings: Vec::new(),
        };
        assert_eq!(
            probe_to_json(&report),
            r#"{"tracks":[],"durationMs":0,"outputSize":0,"warnings":[]}"#
        );
    }

    #[test]
    fn probe_json_escapes_codec_language_and_warnings() {
        let mut report = sample_probe();
        report.tracks.truncate(1);
        report.tracks[0].codec = "a\"b".to_string();
        report.tracks[0].language = "x\ny".to_string();
        report.warnings = vec!["back\\slash\tTab".to_string()];
        let json = probe_to_json(&report);
        assert!(json.contains("\"codec\":\"a\\\"b\","), "{json}");
        assert!(json.contains("\"language\":\"x\\ny\","), "{json}");
        assert!(
            json.ends_with("\"warnings\":[\"back\\\\slash\\tTab\"]}"),
            "{json}"
        );
    }
}

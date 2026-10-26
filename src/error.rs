//! Error type shared by every module.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Io(String),
    InvalidMkv(String),
    Unsupported(String),
    TooLarge(String),
    Sink(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(m) => write!(f, "I/O error: {m}"),
            Error::InvalidMkv(m) => write!(f, "invalid Matroska file: {m}"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
            Error::TooLarge(m) => write!(f, "too large: {m}"),
            Error::Sink(m) => write!(f, "output error: {m}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

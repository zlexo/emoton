//! A tiny HTTP/1.0 client for the three requests the shell makes to its own
//! server on 127.0.0.1 (health, list jobs, cancel a job). Hand-rolled over
//! TcpStream so the shell does not pull in an HTTP stack for that.
//!
//! HTTP/1.0 on purpose: the server then answers without chunked encoding and
//! closes the connection, so "read to EOF" is the whole response. Chunked
//! bodies are still decoded, in case a server answers 1.1-style anyway.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug)]
pub enum HttpError {
    /// Nothing is listening on the port (connection refused or timed out).
    Unreachable,
    /// Something listens, but the exchange failed or was not HTTP.
    Broken(String),
}

#[derive(Debug, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

pub fn request(port: u16, method: &str, path: &str, timeout: Duration) -> Result<Response, HttpError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).map_err(|_| HttpError::Unreachable)?;
    let _ = s.set_read_timeout(Some(timeout));
    let _ = s.set_write_timeout(Some(timeout));
    let req = format!(
        "{method} {path} HTTP/1.0\r\nHost: localhost:{port}\r\nAccept: application/json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).map_err(|e| HttpError::Broken(e.to_string()))?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| HttpError::Broken(e.to_string()))?;
    parse_response(&raw).ok_or_else(|| HttpError::Broken("not an HTTP response".into()))
}

/// Split a raw HTTP response into status and (de-chunked) body.
pub fn parse_response(raw: &[u8]) -> Option<Response> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let body = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status_line = lines.next()?;
    if !status_line.starts_with("HTTP/") {
        return None;
    }
    let status: u16 = status_line.split_whitespace().nth(1)?.parse().ok()?;
    let chunked = lines.any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let body = if chunked { dechunk(body)? } else { body.to_vec() };
    Some(Response { status, body: String::from_utf8_lossy(&body).into_owned() })
}

fn dechunk(mut b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let eol = b.windows(2).position(|w| w == b"\r\n")?;
        let size_str = std::str::from_utf8(&b[..eol]).ok()?;
        let size = usize::from_str_radix(size_str.split(';').next()?.trim(), 16).ok()?;
        b = &b[eol + 2..];
        if size == 0 {
            return Some(out);
        }
        if b.len() < size {
            return None;
        }
        out.extend_from_slice(&b[..size]);
        b = b.get(size + 2..).unwrap_or(&[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_response() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let r = parse_response(raw).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "{\"ok\":true}");
    }

    #[test]
    fn parses_chunked_response() {
        let raw = b"HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n[1,2\r\n2\r\n,3\r\n1\r\n]\r\n0\r\n\r\n";
        let r = parse_response(raw).unwrap();
        assert_eq!(r.status, 404);
        assert_eq!(r.body, "[1,2,3]");
    }

    #[test]
    fn rejects_non_http() {
        assert!(parse_response(b"SSH-2.0-OpenSSH\r\n\r\n").is_none());
        assert!(parse_response(b"HTTP/1.1 200 OK").is_none());
    }
}

//! B6: what the gateway substituted, turned back into what the guest sent,
//! in an answer (credential mode only; p3 answers are not touched).
//!
//! The pairs are exactly the gateway's own substitutions for this request:
//! each secret value back to its placeholder, and each `Basic` credential it
//! re-encoded back to the guest's encoded credential. Every answer header
//! value is rewritten, and the body as it streams: [`Reverse`] holds back
//! at most the longest pattern's length minus one byte, so a value split
//! across two chunks is still found, and the output is the same however the
//! body is chunked (leftmost, then longest match). Not covered: a value the
//! upstream encodes another way (base64 of the token alone, URL encoding);
//! encoded bodies are refused before this runs (http.rs).
use bytes::{Bytes, BytesMut};
use http::{HeaderMap, HeaderValue};
use hyper::body::{Body, Frame, SizeHint};
use std::{
    collections::VecDeque,
    pin::Pin,
    task::{Context, Poll},
};

/// (what went upstream, what the guest sent), never empty on the left.
#[derive(Clone, Debug, Default)]
pub struct Pairs(Vec<(Vec<u8>, Vec<u8>)>);

impl Pairs {
    pub fn add(&mut self, upstream: impl Into<Vec<u8>>, guest: impl Into<Vec<u8>>) {
        let (upstream, guest) = (upstream.into(), guest.into());
        if !upstream.is_empty() && upstream != guest && !self.0.iter().any(|(u, _)| *u == upstream)
        {
            self.0.push((upstream, guest));
        }
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Whether a rewrite can change the body's length.
    pub fn changes_length(&self) -> bool {
        self.0.iter().any(|(u, g)| u.len() != g.len())
    }

    fn longest(&self) -> usize {
        self.0.iter().map(|(u, _)| u.len()).max().unwrap_or(0)
    }

    /// The longest pattern that matches `data` at `at` (only patterns that
    /// fit in `data` can).
    fn at(&self, data: &[u8], at: usize) -> Option<&(Vec<u8>, Vec<u8>)> {
        let rest = &data[at..];
        self.0
            .iter()
            .filter(|(u, _)| rest.starts_with(u))
            .max_by_key(|(u, _)| u.len())
    }

    /// The whole of `data`, rewritten.
    pub fn rewrite(&self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len());
        let mut i = 0;
        while i < data.len() {
            match self.at(data, i) {
                Some((upstream, guest)) => {
                    out.extend_from_slice(guest);
                    i += upstream.len();
                }
                None => {
                    out.push(data[i]);
                    i += 1;
                }
            }
        }
        out
    }

    /// Every header value rewritten; a value that would not be a valid
    /// header is an error (the caller answers 502).
    pub fn rewrite_headers(&self, headers: &mut HeaderMap) -> Result<(), http::Error> {
        if self.is_empty() {
            return Ok(());
        }
        for value in headers.values_mut() {
            let new = self.rewrite(value.as_bytes());
            if new != value.as_bytes() {
                *value = HeaderValue::from_bytes(&new)?;
            }
        }
        Ok(())
    }
}

/// The streaming rewriter: feed chunks, then finish.
pub struct Rewriter {
    pairs: Pairs,
    held: BytesMut,
}

impl Rewriter {
    pub fn new(pairs: Pairs) -> Self {
        Self {
            pairs,
            held: BytesMut::new(),
        }
    }

    /// What can be decided once `chunk` is added; the rest is held.
    pub fn feed(&mut self, chunk: &[u8]) -> Bytes {
        self.held.extend_from_slice(chunk);
        let keep = self.pairs.longest().saturating_sub(1);
        // Every position below `safe` has a whole window of the longest
        // pattern after it, so its match is decided now.
        let safe = self.held.len().saturating_sub(keep);
        let mut out = BytesMut::with_capacity(self.held.len());
        let mut i = 0;
        while i < safe {
            match self.pairs.at(&self.held, i) {
                Some((upstream, guest)) => {
                    out.extend_from_slice(guest);
                    i += upstream.len();
                }
                None => {
                    // Up to the next byte that starts some pattern.
                    let next = self.held[i + 1..safe]
                        .iter()
                        .position(|b| self.pairs.0.iter().any(|(u, _)| u[0] == *b))
                        .map_or(safe, |p| i + 1 + p);
                    out.extend_from_slice(&self.held[i..next]);
                    i = next;
                }
            }
        }
        let _ = self.held.split_to(i);
        out.freeze()
    }

    /// The end of the body: what was held, rewritten.
    pub fn finish(&mut self) -> Bytes {
        let rest = std::mem::take(&mut self.held);
        Bytes::from(self.pairs.rewrite(&rest))
    }
}

/// An answer body with B6 applied to its data and trailers.
pub struct Reversed<B> {
    inner: B,
    rewriter: Rewriter,
    queued: VecDeque<Frame<Bytes>>,
    ended: bool,
}

impl<B> Reversed<B> {
    pub fn new(inner: B, pairs: Pairs) -> Self {
        Self {
            inner,
            rewriter: Rewriter::new(pairs),
            queued: VecDeque::new(),
            ended: false,
        }
    }
}

impl<B> Body for Reversed<B>
where
    B: Body<Data = Bytes> + Unpin,
{
    type Data = Bytes;
    type Error = B::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let this = self.get_mut();
        loop {
            if let Some(frame) = this.queued.pop_front() {
                return Poll::Ready(Some(Ok(frame)));
            }
            if this.ended {
                return Poll::Ready(None);
            }
            match Pin::new(&mut this.inner).poll_frame(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Err(error))) => {
                    // What was held is not sent: the answer is broken anyway,
                    // and a held part may be the start of a value.
                    this.ended = true;
                    return Poll::Ready(Some(Err(error)));
                }
                Poll::Ready(Some(Ok(frame))) => match frame.into_data() {
                    Ok(data) => {
                        let out = this.rewriter.feed(&data);
                        if !out.is_empty() {
                            this.queued.push_back(Frame::data(out));
                        }
                    }
                    Err(frame) => {
                        let rest = this.rewriter.finish();
                        if !rest.is_empty() {
                            this.queued.push_back(Frame::data(rest));
                        }
                        if let Ok(mut trailers) = frame.into_trailers()
                            && this.rewriter.pairs.rewrite_headers(&mut trailers).is_ok()
                        {
                            this.queued.push_back(Frame::trailers(trailers));
                        }
                    }
                },
                Poll::Ready(None) => {
                    this.ended = true;
                    let rest = this.rewriter.finish();
                    if !rest.is_empty() {
                        this.queued.push_back(Frame::data(rest));
                    }
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.ended && self.queued.is_empty()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    const TOKEN: &str = "ghs_realtokenvalue0123456789abcdefABCDEF";
    const PH: &str = "cube_ph_github_AbCdEfGhIjKlMnOpQrStUv";

    fn pairs() -> Pairs {
        let mut pairs = Pairs::default();
        pairs.add(TOKEN, PH);
        // The Basic credential re-encoded, and the guest's own encoding.
        pairs.add(
            "eC1hY2Nlc3MtdG9rZW46Z2hzX3JlYWw=",
            "eC1hY2Nlc3MtdG9rZW46Y3ViZV9waA==",
        );
        pairs
    }

    fn streamed(pairs: &Pairs, data: &[u8], cuts: &[usize]) -> Vec<u8> {
        let mut rewriter = Rewriter::new(pairs.clone());
        let mut out = vec![];
        let mut last = 0;
        for &cut in cuts.iter().chain([data.len()].iter()) {
            out.extend_from_slice(&rewriter.feed(&data[last..cut]));
            last = cut;
        }
        out.extend_from_slice(&rewriter.finish());
        out
    }

    #[test]
    fn every_split_of_the_token_gives_the_same_answer() {
        let pairs = pairs();
        let body = format!("a{TOKEN}b Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3JlYWw= {TOKEN}{TOKEN}");
        let want = format!("a{PH}b Basic eC1hY2Nlc3MtdG9rZW46Y3ViZV9waA== {PH}{PH}");
        assert_eq!(pairs.rewrite(body.as_bytes()), want.as_bytes());
        let bytes = body.as_bytes();
        for a in 0..=bytes.len() {
            assert_eq!(streamed(&pairs, bytes, &[a]), want.as_bytes(), "cut at {a}");
            for b in (a..=bytes.len()).step_by(7) {
                assert_eq!(
                    streamed(&pairs, bytes, &[a, b]),
                    want.as_bytes(),
                    "cuts {a} {b}"
                );
            }
        }
        // One byte at a time.
        let ones: Vec<usize> = (1..bytes.len()).collect();
        assert_eq!(streamed(&pairs, bytes, &ones), want.as_bytes());
    }

    #[test]
    fn a_prefix_of_the_token_at_the_end_is_kept_and_never_lost() {
        let pairs = pairs();
        let body = format!("{}{}", "x".repeat(50), &TOKEN[..20]);
        let mut rewriter = Rewriter::new(pairs.clone());
        let early = rewriter.feed(body.as_bytes());
        // At most the longest pattern less one byte is held.
        assert_eq!(early.len(), body.len() - (TOKEN.len() - 1));
        assert!(body.as_bytes().starts_with(&early));
        let rest = rewriter.finish();
        assert_eq!([&early[..], &rest[..]].concat(), body.as_bytes());
        // Nothing to hold without pairs: bytes pass at once and unchanged.
        let mut none = Rewriter::new(Pairs::default());
        assert_eq!(&none.feed(TOKEN.as_bytes())[..], TOKEN.as_bytes());
        assert!(none.finish().is_empty());
    }

    #[test]
    fn the_longest_match_wins_and_overlaps_resolve_left_first() {
        let mut pairs = Pairs::default();
        pairs.add("abc", "1");
        pairs.add("abcdef", "2");
        pairs.add("cde", "3");
        assert_eq!(pairs.rewrite(b"abcdefabcdxcde"), b"21dx3");
        for cut in 0..14 {
            assert_eq!(
                streamed(&pairs, b"abcdefabcdxcde", &[cut]),
                b"21dx3",
                "cut {cut}"
            );
        }
        // Same pattern twice, empty or unchanged: ignored.
        pairs.add("abc", "9");
        pairs.add("", "x");
        pairs.add("same", "same");
        assert_eq!(pairs.0.len(), 3);
    }

    #[test]
    fn headers_are_rewritten_and_invalid_results_refused() {
        let pairs = pairs();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-echo",
            HeaderValue::from_str(&format!("Bearer {TOKEN}")).unwrap(),
        );
        headers.insert(
            "location",
            HeaderValue::from_str(&format!("https://x.example/?t={TOKEN}")).unwrap(),
        );
        pairs.rewrite_headers(&mut headers).unwrap();
        assert_eq!(headers["x-echo"], format!("Bearer {PH}"));
        assert_eq!(headers["location"], format!("https://x.example/?t={PH}"));
        let mut bad = Pairs::default();
        bad.add("ok", "a\nb");
        let mut headers = HeaderMap::new();
        headers.insert("x", HeaderValue::from_static("ok"));
        assert!(bad.rewrite_headers(&mut headers).is_err());
    }

    /// A body of the given data frames, one per poll.
    struct Frames(VecDeque<Bytes>);
    impl Body for Frames {
        type Data = Bytes;
        type Error = std::convert::Infallible;
        fn poll_frame(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
            Poll::Ready(self.0.pop_front().map(|data| Ok(Frame::data(data))))
        }
    }

    #[tokio::test]
    async fn the_body_streams_with_the_value_split_across_frames() {
        let (a, b) = TOKEN.split_at(17);
        let frames = Frames(VecDeque::from([
            Bytes::from(format!("start {a}")),
            Bytes::from(format!("{b} end {}", &TOKEN[..5])),
        ]));
        let out = Reversed::new(frames, pairs())
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(out, format!("start {PH} end {}", &TOKEN[..5]));
    }
}

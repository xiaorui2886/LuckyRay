//! Keep a suffix across streamed chunks so split credentials are never emitted.
pub(crate) struct Redactor { needle: String, pending: String }
impl Redactor {
    pub(crate) fn new(needle: String) -> Self { Self { needle, pending: String::new() } }
    pub(crate) fn push(&mut self, text: &str, finish: bool) -> String {
        self.pending.push_str(text);
        if self.needle.is_empty() { return std::mem::take(&mut self.pending); }
        let mut end = if finish { self.pending.len() } else { self.pending.len().saturating_sub(self.needle.len().saturating_sub(1)) };
        while !self.pending.is_char_boundary(end) { end -= 1; }
        let mut start = 0;
        let mut out = String::new();
        while let Some(found) = self.pending[start..].find(&self.needle).map(|p| p + start) {
            if found >= end { break; }
            out.push_str(&self.pending[start..found]);
            out.push_str("[redacted]");
            start = found + self.needle.len();
        }
        end = end.max(start);
        out.push_str(&self.pending[start..end]);
        self.pending.drain(..end);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::Redactor;
    #[test]
    fn stream_redacts_a_secret_even_when_it_crosses_chunks() {
        let mut r = Redactor::new("secret-🔑".into());
        let mut result = r.push("hello sec", false);
        result.push_str(&r.push("ret-", false));
        result.push_str(&r.push("🔑 world secret-🔑!", false));
        result.push_str(&r.push("", true));
        assert_eq!(result, "hello [redacted] world [redacted]!");
    }
    #[test]
    fn every_unicode_boundary_and_overlapping_secret_prefix_stays_private() {
        let text = "前缀 token-token-🔑 后缀 token-🔑";
        let needle = "token-🔑";
        let expected = text.replace(needle, "[redacted]");
        for split in (0..=text.len()).filter(|i| text.is_char_boundary(*i)) {
            let mut r = Redactor::new(needle.into());
            let mut result = r.push(&text[..split], false);
            result.push_str(&r.push(&text[split..], false));
            result.push_str(&r.push("", true));
            assert_eq!(result, expected, "split at {split}");
        }
    }
}

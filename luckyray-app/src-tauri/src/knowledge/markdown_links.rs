//! Parser-confirmed source spans shared by attachment reads and mutation plans.
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use std::ops::Range;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LinkSyntax {
    Markdown,
    Wiki,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AttachmentLink {
    pub span: Range<usize>,
    pub destination_span: Option<Range<usize>>,
    pub destination: String,
    pub syntax: LinkSyntax,
    pub embedded: bool,
    pub alias: Option<String>,
    pub line: usize,
}

pub(crate) fn attachment_links(source: &str) -> Vec<AttachmentLink> {
    let mut line_starts = vec![0];
    line_starts.extend(
        source
            .bytes()
            .enumerate()
            .filter_map(|(offset, byte)| (byte == b'\n').then_some(offset + 1)),
    );
    let options = Options::ENABLE_WIKILINKS
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS;
    let mut links = Vec::new();
    for (event, span) in Parser::new_ext(source, options).into_offset_iter() {
        let (link_type, destination, embedded) = match event {
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                ..
            }) => (link_type, dest_url, true),
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) => (link_type, dest_url, false),
            _ => continue,
        };
        let raw = &source[span.clone()];
        let wiki = matches!(link_type, LinkType::WikiLink { .. });
        let (destination_span, alias) = if wiki {
            let start = if raw.starts_with("![[") { 3 } else { 2 };
            let body = &raw[start..raw.len() - 2];
            let end = body.find('|').unwrap_or(body.len());
            let target = &body[..end];
            let leading = target.len() - target.trim_start().len();
            (
                Some(span.start + start + leading..span.start + start + target.trim_end().len()),
                body.get(end + 1..).map(str::to_owned),
            )
        } else if link_type == LinkType::Inline {
            (
                inline_destination_span(raw).map(|r| span.start + r.start..span.start + r.end),
                None,
            )
        } else {
            // Reference definitions can be shared with non-attachment links. Resolve them,
            // but explicitly leave them unpatchable until a definition-aware plan is made.
            (None, None)
        };
        // Wiki filenames do not inherit CommonMark backslash/entity unescaping.
        let destination = if wiki {
            destination_span
                .as_ref()
                .map(|r| source[r.clone()].to_owned())
                .unwrap_or_default()
        } else {
            destination.into_string()
        };
        links.push(AttachmentLink {
            span: span.clone(),
            destination_span,
            destination,
            syntax: if wiki {
                LinkSyntax::Wiki
            } else {
                LinkSyntax::Markdown
            },
            embedded,
            alias,
            line: line_starts.partition_point(|start| *start <= span.start),
        });
    }
    links
}

// This scanner never recognizes links: it only locates the destination within an
// Inline node already accepted by CommonMark. Byte offsets remain valid UTF-8 boundaries.
fn inline_destination_span(raw: &str) -> Option<Range<usize>> {
    let bytes = raw.as_bytes();
    let mut cursor = usize::from(bytes.first() == Some(&b'!'));
    if bytes.get(cursor) != Some(&b'[') {
        return None;
    }
    cursor += 1;
    let mut depth = 1usize;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\\' => cursor += 2,
            b'`' => {
                let run = bytes[cursor..]
                    .iter()
                    .take_while(|byte| **byte == b'`')
                    .count();
                let delimiter = &raw[cursor..cursor + run];
                if let Some(end) = raw[cursor + run..].find(delimiter) {
                    cursor += run + end + run;
                } else {
                    cursor += run;
                }
            }
            b'[' => {
                depth += 1;
                cursor += 1;
            }
            b']' => {
                depth -= 1;
                cursor += 1;
                if depth == 0 {
                    break;
                }
            }
            _ => cursor += 1,
        }
    }
    if bytes.get(cursor) != Some(&b'(') {
        return None;
    }
    cursor += 1;
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b'<') {
        cursor += 1;
        let start = cursor;
        while cursor < bytes.len() {
            match bytes[cursor] {
                b'\\' => cursor += 2,
                b'>' => return Some(start..cursor),
                _ => cursor += 1,
            }
        }
        return None;
    }
    let start = cursor;
    let mut depth = 0usize;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\\' => cursor += 2,
            b'(' => {
                depth += 1;
                cursor += 1;
            }
            b')' if depth > 0 => {
                depth -= 1;
                cursor += 1;
            }
            b')' | b' ' | b'\t' | b'\r' | b'\n' => return Some(start..cursor),
            _ => cursor += 1,
        }
    }
    None
}

/// Apply only disjoint, parser-owned target spans. Conflicting shared spans fail closed.
pub(crate) fn patch_destinations(
    source: &str,
    patches: &[(Range<usize>, String)],
) -> Result<String, &'static str> {
    let allowed: Vec<_> = attachment_links(source)
        .into_iter()
        .filter_map(|link| link.destination_span)
        .collect();
    let mut patches = patches.to_vec();
    patches.sort_by_key(|(range, _)| (range.start, range.end));
    patches.dedup();
    let mut previous_end = 0;
    for (range, _) in &patches {
        if !allowed.contains(range) || range.start < previous_end {
            return Err("invalid-or-conflicting-link-patch");
        }
        previous_end = range.end;
    }
    let mut result = source.to_owned();
    for (range, replacement) in patches.into_iter().rev() {
        result.replace_range(range, &replacement);
    }
    Ok(result)
}

pub(crate) fn patch_links(
    source: &str,
    patches: &[(Range<usize>, String)],
) -> Result<String, &'static str> {
    let allowed: Vec<_> = attachment_links(source)
        .into_iter()
        .map(|link| link.span)
        .collect();
    let mut patches = patches.to_vec();
    patches.sort_by_key(|(range, _)| (range.start, range.end));
    patches.dedup();
    let mut end = 0;
    for (range, _) in &patches {
        if !allowed.contains(range) || range.start < end {
            return Err("invalid-or-conflicting-link-patch");
        }
        end = range.end;
    }
    let mut result = source.to_owned();
    for (range, replacement) in patches.into_iter().rev() {
        result.replace_range(range, &replacement);
    }
    Ok(result)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LocalTarget {
    pub path: String,
    pub fragment: String,
    pub basename_search: bool,
}

/// Decode URI bytes once, after removing the literal fragment delimiter. Encoded
/// separators are rejected instead of allowing an encoded path to change authority.
pub(crate) fn local_target(
    destination: &str,
    syntax: LinkSyntax,
    note: &str,
) -> Result<LocalTarget, &'static str> {
    let (raw, fragment) = destination
        .split_once('#')
        .map(|(p, f)| (p, format!("#{f}")))
        .unwrap_or((destination, String::new()));
    if raw.is_empty() {
        return Err("self-reference");
    }
    if raw.contains(':') || raw.starts_with("//") {
        return Err("remote-or-absolute");
    }
    let decoded = if syntax == LinkSyntax::Markdown {
        decode_uri_path(raw)?
    } else {
        raw.to_owned()
    };
    if syntax == LinkSyntax::Markdown
        && raw
            .split('/')
            .zip(decoded.split('/'))
            .any(|(raw, decoded)| raw.contains('%') && matches!(decoded, "." | ".."))
    {
        return Err("encoded-traversal");
    }
    if decoded.starts_with(['/', '\\', '~']) || decoded.contains([':', '\0', '\\']) {
        return Err("outside-vault");
    }
    let relative_to_note =
        syntax == LinkSyntax::Markdown || decoded.starts_with("./") || decoded.starts_with("../");
    let basename_search = syntax == LinkSyntax::Wiki && !decoded.contains('/');
    let mut segments: Vec<&str> = if relative_to_note {
        note.rsplit_once('/')
            .map(|(parent, _)| parent.split('/').collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    for segment in decoded.split('/') {
        match segment {
            "." => (),
            ".." => {
                if segments.pop().is_none() {
                    return Err("outside-vault");
                }
            }
            "" => return Err("invalid-path"),
            _ if segment.eq_ignore_ascii_case(".luckyray")
                || segment.ends_with(['.', ' '])
                || segment.chars().any(char::is_control)
                || segment.contains(['<', '>', '"', '|', '?', '*']) =>
            {
                return Err("denied-path")
            }
            _ => segments.push(segment),
        }
    }
    if segments.is_empty() {
        return Err("invalid-path");
    }
    Ok(LocalTarget {
        path: segments.join("/"),
        fragment,
        basename_search,
    })
}

pub(super) fn decode_uri_path(raw: &str) -> Result<String, &'static str> {
    let mut result = Vec::new();
    let bytes = raw.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] == b'%' {
            let digits = bytes
                .get(cursor + 1..cursor + 3)
                .ok_or("invalid-encoding")?;
            let high = (digits[0] as char).to_digit(16).ok_or("invalid-encoding")?;
            let low = (digits[1] as char).to_digit(16).ok_or("invalid-encoding")?;
            let byte = (high * 16 + low) as u8;
            if matches!(byte, b'/' | b'\\' | 0) {
                return Err("encoded-separator");
            }
            result.push(byte);
            cursor += 3;
        } else {
            result.push(bytes[cursor]);
            cursor += 1;
        }
    }
    String::from_utf8(result).map_err(|_| "invalid-encoding")
}

pub(crate) fn markdown_relative_target(note: &str, attachment: &str) -> String {
    let parent: Vec<_> = note
        .rsplit_once('/')
        .map(|(p, _)| p.split('/').collect())
        .unwrap_or_default();
    let target: Vec<_> = attachment.split('/').collect();
    let shared = parent
        .iter()
        .zip(&target)
        .take_while(|(a, b)| a == b)
        .count();
    let mut relative = "../".repeat(parent.len() - shared);
    if relative.is_empty() {
        relative.push_str("./");
    }
    relative.push_str(&target[shared..].join("/"));
    let mut encoded = String::new();
    for byte in relative.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'-' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_semantics_and_single_uri_decode() {
        assert_eq!(
            local_target(
                "../attachments/a%20b.png",
                LinkSyntax::Markdown,
                "notes/n.md"
            )
            .unwrap()
            .path,
            "attachments/a b.png"
        );
        assert_eq!(
            local_target("attachments/图片.png", LinkSyntax::Wiki, "notes/n.md")
                .unwrap()
                .path,
            "attachments/图片.png"
        );
        assert_eq!(
            local_target("attachments/a.png", LinkSyntax::Markdown, "notes/n.md")
                .unwrap()
                .path,
            "notes/attachments/a.png"
        );
        assert_eq!(
            local_target("a%2520b.png", LinkSyntax::Markdown, "n.md")
                .unwrap()
                .path,
            "a%20b.png"
        );
        assert_eq!(
            local_target("a%20b.png", LinkSyntax::Wiki, "n.md")
                .unwrap()
                .path,
            "a%20b.png"
        );
        assert!(
            local_target("a.png", LinkSyntax::Wiki, "n.md")
                .unwrap()
                .basename_search
        );
        for target in [
            "../../x",
            "%2Foutside",
            "%5Coutside",
            "%FF.png",
            "%xx.png",
            "../.luckyray/a",
            "C:/x",
        ] {
            assert!(
                local_target(target, LinkSyntax::Markdown, "notes/n.md").is_err(),
                "{target}"
            );
        }
        assert_eq!(
            local_target("a%23b.pdf#page=2", LinkSyntax::Markdown, "n.md").unwrap(),
            LocalTarget {
                path: "a#b.pdf".into(),
                fragment: "#page=2".into(),
                basename_search: false
            }
        );
    }

    #[test]
    fn generated_relative_paths_round_trip_reserved_and_unicode_names() {
        for note in ["n.md", "notes/n.md", "deep/子/n.md"] {
            let path = "attachments/图 片#100%(x).png";
            let generated = markdown_relative_target(note, path);
            assert_eq!(
                local_target(&generated, LinkSyntax::Markdown, note)
                    .unwrap()
                    .path,
                path
            );
        }
    }

    #[test]
    fn code_in_a_markdown_label_cannot_steal_the_destination_span() {
        let source = "![a `]` label](./real.png) and [nested [label]](a(b).pdf)";
        let links = attachment_links(source);
        assert_eq!(links.len(), 2);
        assert_eq!(
            &source[links[0].destination_span.clone().unwrap()],
            "./real.png"
        );
        assert_eq!(
            &source[links[1].destination_span.clone().unwrap()],
            "a(b).pdf"
        );
        assert!(local_target("%2e%2e/a.png", LinkSyntax::Markdown, "notes/n.md").is_err());
    }

    #[test]
    fn patches_touch_only_parser_owned_spans_and_reject_conflicts() {
        let source = "中文 `![[a.png]]` ![[a.png|300]] and ![A](./b.png \"title\")";
        let links = attachment_links(source);
        let patches = vec![
            (
                links[0].destination_span.clone().unwrap(),
                "attachments/a.png".into(),
            ),
            (
                links[1].destination_span.clone().unwrap(),
                "../b.png".into(),
            ),
        ];
        assert_eq!(
            patch_destinations(source, &patches).unwrap(),
            "中文 `![[a.png]]` ![[attachments/a.png|300]] and ![A](../b.png \"title\")"
        );
        assert!(patch_destinations(source, &[(0..6, "bad".into())]).is_err());
        let mut conflict = patches.clone();
        conflict.push((patches[0].0.clone(), "different".into()));
        assert!(patch_destinations(source, &conflict).is_err());
    }

    #[test]
    fn required_wiki_and_markdown_forms_preserve_target_ranges() {
        let source = "![[图片.png]]\n![[attachments/图片.png]]\n![[图片.png|300]]\n![图片](../attachments/图片.png)";
        let links = attachment_links(source);
        assert_eq!(links.len(), 4);
        assert_eq!(links[2].alias.as_deref(), Some("300"));
        assert_eq!(links[3].syntax, LinkSyntax::Markdown);
        assert_eq!(links[3].destination, "../attachments/图片.png");
        for link in links {
            assert_eq!(&source[link.destination_span.unwrap()], link.destination);
        }
    }

    #[test]
    fn ignores_code_frontmatter_html_and_escaped_openers() {
        let source = "---\nx: '![[meta.png]]'\n---\n`![[inline.png]]`\n\n    ![[indent.png]]\n\n```md\n![[fenced.png]]\n```\n\n<div>\n![[html.png]]\n</div>\n\n\\!\\[\\[escaped.png]]\n![[real.png]]";
        let links = attachment_links(source);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].destination, "real.png");
    }

    #[test]
    fn markdown_destinations_are_semantically_unescaped_once() {
        let source = "![a](<../图 片/a%20b.png> \"title\")\n[x](a\\(b\\).pdf)\n![x](a&amp;b.png)";
        let links = attachment_links(source);
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].destination, "../图 片/a%20b.png");
        assert_eq!(links[1].destination, "a(b).pdf");
        assert_eq!(links[2].destination, "a&b.png");
        assert_eq!(
            &source[links[1].destination_span.clone().unwrap()],
            "a\\(b\\).pdf"
        );
    }

    #[test]
    fn reference_style_is_explicitly_unpatchable_and_still_resolvable() {
        let source =
            "![image][shared]\n[download][shared]\n\n[shared]: ../attachments/a.png \"title\"";
        let links = attachment_links(source);
        assert_eq!(links.len(), 2);
        assert!(links.iter().all(|link| link.destination_span.is_none()));
        assert!(links
            .iter()
            .all(|link| link.destination == "../attachments/a.png"));
    }
}

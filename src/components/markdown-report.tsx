"use client";

// ============================================================================
// Dependency-free Markdown renderer for the benchmark strategist report.
// Handles the constructs the report prompt emits: #/##/### headings, paragraphs,
// ordered/unordered lists, blockquotes, --- rules, GFM tables, and inline
// **bold** / `code` / *italic* / [links](url) / bare URLs (clickable — the
// report carries full ad-image and landing URLs the user must be able to open).
//
// Shared by /benchmark-lab and the per-brand benchmark so both render the exact
// same report. No external markdown dependency (the project ships none).
// ============================================================================

import React from "react";

export interface MdColors {
  text: string;
  textMuted: string;
  textFaint: string;
  border: string;
  accent: string;
}

const codeStyle: React.CSSProperties = {
  fontFamily: "var(--font-geist-mono), monospace",
  fontSize: "0.85em",
  padding: "1px 6px",
  borderRadius: 5,
  background: "rgba(127,127,127,0.18)",
  wordBreak: "break-all",
};

// A creative thumbnail with graceful fallback to a link when the image 404s /
// hotlink-blocks (the Transparency image URLs are usually open, but be safe).
function MdImage({ src, alt, colors }: { src: string; alt: string; colors: MdColors }) {
  const [ok, setOk] = React.useState(true);
  if (!ok) {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" style={{ color: colors.accent, textDecoration: "underline", wordBreak: "break-all" }}>
        {alt || "image"} ↗
      </a>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onError={() => setOk(false)}
      style={{ maxWidth: 160, maxHeight: 110, borderRadius: 6, border: `1px solid ${colors.border}`, display: "block", objectFit: "cover" }}
    />
  );
}

function renderInline(text: string, colors: MdColors, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Order matters: image ![](), bold, code, [md](link), bare url, italic.
  const regex =
    /(!\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\bhttps?:\/\/[^\s)]+|\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const linkStyle: React.CSSProperties = {
    color: colors.accent,
    textDecoration: "underline",
    wordBreak: "break-all",
  };
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("![")) {
      const mm = tok.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      const alt = mm?.[1] ?? "";
      const src = mm?.[2] ?? "";
      nodes.push(<MdImage key={`${keyBase}-${i++}`} src={src} alt={alt} colors={colors} />);
    } else if (tok.startsWith("**")) {
      nodes.push(
        <strong key={`${keyBase}-${i++}`} style={{ color: colors.text, fontWeight: 700 }}>
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("`")) {
      nodes.push(
        <code key={`${keyBase}-${i++}`} style={codeStyle}>
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const label = mm?.[1] ?? tok;
      const href = mm?.[2] ?? "#";
      nodes.push(
        <a key={`${keyBase}-${i++}`} href={href} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          {label}
        </a>,
      );
    } else if (/^https?:\/\//.test(tok)) {
      nodes.push(
        <a key={`${keyBase}-${i++}`} href={tok} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          {tok}
        </a>,
      );
    } else {
      nodes.push(<em key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function splitRow(line: string): string[] {
  // | a | b | c |  →  ["a","b","c"]
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableSep = (line: string): boolean => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");

export function MarkdownReport({ markdown, colors }: { markdown: string; colors: MdColors }) {
  const lines = (markdown || "").replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (para.length) {
      blocks.push(
        <p key={`p${key++}`} style={{ margin: "0 0 12px", lineHeight: 1.7, color: colors.textMuted, fontSize: 14 }}>
          {renderInline(para.join(" "), colors, `p${key}`)}
        </p>,
      );
      para = [];
    }
  };
  const flushList = () => {
    if (!list) return;
    const L = list;
    const liStyle: React.CSSProperties = { margin: "0 0 6px", lineHeight: 1.6, color: colors.textMuted, fontSize: 14 };
    const wrapStyle: React.CSSProperties = { margin: "0 0 12px", paddingLeft: 20 };
    blocks.push(
      L.ordered ? (
        <ol key={`l${key++}`} style={wrapStyle}>
          {L.items.map((it, idx) => (
            <li key={idx} style={liStyle}>{renderInline(it, colors, `l${key}-${idx}`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={`l${key++}`} style={wrapStyle}>
          {L.items.map((it, idx) => (
            <li key={idx} style={liStyle}>{renderInline(it, colors, `l${key}-${idx}`)}</li>
          ))}
        </ul>
      ),
    );
    list = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trimEnd();

    if (!line.trim()) {
      flushAll();
      continue;
    }

    // GFM table: a header row followed by a separator row.
    if (line.trim().startsWith("|") && idx + 1 < lines.length && isTableSep(lines[idx + 1])) {
      flushAll();
      const header = splitRow(line);
      const rows: string[][] = [];
      let j = idx + 2;
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      idx = j - 1;
      const th: React.CSSProperties = {
        textAlign: "left",
        padding: "8px 10px",
        borderBottom: `1px solid ${colors.border}`,
        color: colors.text,
        fontWeight: 700,
        fontSize: 12.5,
        whiteSpace: "nowrap",
      };
      const td: React.CSSProperties = {
        padding: "8px 10px",
        borderBottom: `1px solid ${colors.border}`,
        color: colors.textMuted,
        fontSize: 13,
        verticalAlign: "top",
      };
      blocks.push(
        <div key={`t${key++}`} style={{ overflowX: "auto", margin: "0 0 14px" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 360 }}>
            <thead>
              <tr>{header.map((h, hi) => <th key={hi} style={th}>{renderInline(h, colors, `th${key}-${hi}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((cell, ci) => <td key={ci} style={td}>{renderInline(cell, colors, `td${key}-${ri}-${ci}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^###\s+/.test(line)) {
      flushAll();
      blocks.push(<h3 key={`h${key++}`} style={{ fontSize: 14.5, fontWeight: 700, color: colors.text, margin: "16px 0 8px" }}>{renderInline(line.replace(/^###\s+/, ""), colors, `h${key}`)}</h3>);
      continue;
    }
    if (/^##\s+/.test(line)) {
      flushAll();
      blocks.push(<h2 key={`h${key++}`} style={{ fontSize: 16, fontWeight: 800, color: colors.text, margin: "18px 0 10px" }}>{renderInline(line.replace(/^##\s+/, ""), colors, `h${key}`)}</h2>);
      continue;
    }
    if (/^#\s+/.test(line)) {
      flushAll();
      blocks.push(<h2 key={`h${key++}`} style={{ fontSize: 17, fontWeight: 800, color: colors.text, margin: "18px 0 10px" }}>{renderInline(line.replace(/^#\s+/, ""), colors, `h${key}`)}</h2>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushAll();
      blocks.push(
        <blockquote key={`q${key++}`} style={{ margin: "0 0 12px", padding: "8px 14px", borderLeft: `3px solid ${colors.accent}`, background: "rgba(16,185,129,0.06)", borderRadius: "0 8px 8px 0", color: colors.textMuted, fontSize: 13.5 }}>
          {renderInline(line.replace(/^>\s?/, ""), colors, `q${key}`)}
        </blockquote>,
      );
      continue;
    }
    if (/^---+$/.test(line) || /^```/.test(line)) {
      // horizontal rule (and we render code fences as a simple divider — the
      // report shouldn't emit fenced code, but stay graceful if it does).
      flushAll();
      blocks.push(<hr key={`hr${key++}`} style={{ border: "none", borderTop: `1px solid ${colors.border}`, margin: "16px 0" }} />);
      continue;
    }

    const oli = line.match(/^(\d+)\.\s+(.*)/);
    const uli = line.match(/^[-*]\s+(.*)/);
    if (oli) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(oli[2]);
      continue;
    }
    if (uli) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(uli[1]);
      continue;
    }

    flushList();
    para.push(line);
  }
  flushAll();
  return <div>{blocks}</div>;
}

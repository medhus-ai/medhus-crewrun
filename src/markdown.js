export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// XSS-safe: HTML-escape runs FIRST so no input byte ever reaches the page as markup; link hrefs restricted to http(s), #, and /.
export function renderMarkdown(value, { headingOffset = 2 } = {}) {
  const text = String(value ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const html = [];
  let index = 0;

  let detailsDepth = 0;
  while (index < lines.length) {
    const line = lines[index];

    // Structural <details>/<summary> passthrough (whitelisted, no attributes besides
    // literal `open`) so crew comments can fold long sections.
    const detailsOpen = line.match(/^<details( open)?>\s*(?:<summary>(.*?)<\/summary>)?\s*$/i);
    if (detailsOpen) {
      detailsDepth += 1;
      html.push(`<details${detailsOpen[1] ? " open" : ""}>`);
      if (detailsOpen[2] != null) html.push(`<summary>${summaryInline(detailsOpen[2])}</summary>`);
      index += 1;
      continue;
    }
    const summaryOnly = line.match(/^<summary>(.*?)<\/summary>\s*$/i);
    if (summaryOnly && detailsDepth > 0) {
      html.push(`<summary>${summaryInline(summaryOnly[1])}</summary>`);
      index += 1;
      continue;
    }
    if (/^<\/details>\s*$/i.test(line) && detailsDepth > 0) {
      detailsDepth -= 1;
      html.push("</details>");
      index += 1;
      continue;
    }

    if (/^```/.test(line)) {
      // Fence language rides along (e.g. class="language-mermaid") so the client can render diagrams.
      const lang = (line.match(/^```([a-zA-Z0-9-]+)/)?.[1] || "").toLowerCase();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence (or EOF)
      const langClass = lang ? ` class="language-${lang}"` : "";
      html.push(`<pre><code${langClass}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"), { headingOffset })}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, index)) {
      const { html: tableHtml, nextIndex } = renderTable(lines, index);
      html.push(tableHtml);
      index = nextIndex;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(Math.max(heading[1].length + headingOffset, 1), 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`);
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() !== ""
      && !/^```|^#{1,6}\s|^\s*([-*]|\d+\.)\s+|^\s*>\s?|^\s*---+\s*$/.test(lines[index])
      && !isTableStart(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
  }

  while (detailsDepth > 0) { html.push("</details>"); detailsDepth -= 1; }
  return html.join("\n");
}

function isTableStart(lines, index) {
  const current = lines[index] || "";
  const next = lines[index + 1] || "";
  return current.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function renderTable(lines, index) {
  const headers = splitTableRow(lines[index]);
  index += 2; // skip header and separator
  const rows = [];
  while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  const head = `<thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows.map((row) => `<tr>${headers.map((_h, i) => `<td>${inline(row[i] || "")}</td>`).join("")}</tr>`).join("")}</tbody>`
    : "";
  return { html: `<table>${head}${body}</table>`, nextIndex: index };
}

export function splitTableRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function summaryInline(rawLine) {
  const tokenPrefix = "__CREW_SUMMARY_TAG_";
  const tags = [];
  const line = String(rawLine ?? "").replace(/<\/?(strong|em)>/gi, (tag) => {
    tags.push(tag.toLowerCase());
    return `${tokenPrefix}${tags.length - 1}__`;
  });
  return inline(line).replace(new RegExp(`${tokenPrefix}(\\d+)__`, "g"), (_match, i) => tags[Number(i)]);
}

function inline(rawLine) {
  const tokenPrefix = "__CREW_CODE_SPAN_";
  let line = escapeHtml(String(rawLine).replace(/\u0000/g, ""));
  // Avoid a user-authored placeholder being confused with one we create below.
  line = line.replaceAll(tokenPrefix, "__CREW_CODE_TEXT_");
  // Inline code first so its contents are exempt from further transforms.
  const codeSpans = [];
  line = line.replace(/`([^`]+)`/g, (_match, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `${tokenPrefix}${codeSpans.length - 1}__`;
  });
  line = line.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  line = line.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  line = line.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    if (!/^(https?:\/\/|#|\/)/i.test(href)) return match;
    const externalAttrs = /^https?:\/\//i.test(href) ? ' rel="noopener noreferrer" target="_blank"' : "";
    return `<a href="${href}"${externalAttrs}>${label}</a>`;
  });
  return line.replace(/__CREW_CODE_SPAN_(\d+)__/g, (_match, i) => codeSpans[Number(i)]);
}

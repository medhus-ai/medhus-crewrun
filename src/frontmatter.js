export function parseFrontmatter(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return {};
  const out = {};
  for (const line of normalized.slice(4, end).trim().split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function parseInlineList(value) {
  const text = String(value || "").trim();
  const match = text.match(/^\[(.*)\]$/);
  if (!match) return [];
  return match[1].split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

const TRACE_LINE = /^\s*\[(?:cmd|edit|mcp|search|tool|runner-error)(?:\s[^\]]*)?\]/i;
const REVIEW_VERDICT_LINE = /^\s*(?:\*\*)?verdict(?:\*\*)?\s*:\s*(?:approve|request[ -]changes|comment-only)\b/i;
const REPAIR_SUMMARY_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:engineer\s+)?(?:repair\s+summary|summary\s+of\s+changes(?:\s+made)?(?:\s+due\s+to|\s+after)\s+review)(?:\*\*)?\s*:?[ \t]*$/i;

export function finalReviewOutput(text) {
  const lines = normalizedLines(text);
  if (!lines.length) return "";

  const verdictIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (REVIEW_VERDICT_LINE.test(lines[index])) verdictIndexes.push(index);
  }
  if (verdictIndexes.length) {
    return cleanFinalLines(lines.slice(verdictIndexes.at(-1)));
  }

  return finalAgentOutput(text);
}

export function finalRepairOutput(text) {
  const lines = normalizedLines(text);
  if (!lines.length) return "";

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!REPAIR_SUMMARY_HEADING.test(lines[index])) continue;
    return cleanFinalLines(lines.slice(index + 1));
  }

  return finalAgentOutput(text);
}

export function finalAgentOutput(text) {
  const lines = normalizedLines(text);
  if (!lines.length) return "";

  let start = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!TRACE_LINE.test(lines[index])) continue;
    start = index + 1;
    break;
  }
  return cleanFinalLines(lines.slice(start));
}

function normalizedLines(text) {
  return String(text || "").replace(/\r\n?/g, "\n").split("\n");
}

function cleanFinalLines(lines) {
  const kept = lines.filter((line) => !TRACE_LINE.test(line));
  while (kept.length && !kept[0].trim()) kept.shift();
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return kept.join("\n").trim();
}

import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, renderMarkdown, splitTableRow } from "../src/markdown.js";

test("markdown renders headings, lists, code, and escapes raw HTML", () => {
  const html = renderMarkdown("# Title\n\n- one\n- two\n\n`x < y`\n\n<script>bad()</script>");
  assert.match(html, /<h3[^>]*>Title<\/h3>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<code>x &lt; y<\/code>/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.equal(escapeHtml("<&>"), "&lt;&amp;&gt;");
  assert.deepEqual(splitTableRow("| a | b |"), ["a", "b"]);
});

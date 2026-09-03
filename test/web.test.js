import assert from "node:assert/strict";
import test from "node:test";

import { hostAllowed, htmlToText, normalizeWeb, parseSearchResults, webFetch, webSearch } from "../src/web.js";

const html = (body, headers = { "content-type": "text/html" }, status = 200) => ({
  status, ok: status < 400, headers: new Map(Object.entries(headers)), text: async () => body
});

test("normalizeWeb: off by default, true opens everything, objects are normalized", () => {
  assert.equal(normalizeWeb(undefined), false);
  assert.equal(normalizeWeb(false), false);
  assert.deepEqual(normalizeWeb(true), { allow: [], search: true, max_chars: 40_000 });
  assert.deepEqual(normalizeWeb({ allow: [" *.Arxiv.org ", "github.com"], search: false, max_chars: 100 }),
    { allow: ["*.arxiv.org", "github.com"], search: false, max_chars: 100 });
  assert.equal(normalizeWeb({ enabled: false }), false);
});

test("hostAllowed: exact and wildcard patterns; empty allowlist is open", () => {
  assert.equal(hostAllowed("anything.example", []), true);
  assert.equal(hostAllowed("github.com", ["github.com"]), true);
  assert.equal(hostAllowed("api.github.com", ["github.com"]), false);
  assert.equal(hostAllowed("arxiv.org", ["*.arxiv.org"]), true);
  assert.equal(hostAllowed("export.arxiv.org", ["*.arxiv.org"]), true);
  assert.equal(hostAllowed("notarxiv.org", ["*.arxiv.org"]), false);
});

test("htmlToText strips scripts/styles/tags and decodes entities", () => {
  const text = htmlToText("<html><head><style>p{}</style><script>x()</script></head><body><h1>Hi &amp; bye</h1><p>one</p><p>two&nbsp;&#8212;</p></body></html>");
  assert.equal(text, "Hi & bye\none\ntwo —");
});

test("webFetch: follows redirects with allowlist re-check, strips html, caps text", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "https://a.example/") return { status: 302, headers: new Map([["location", "https://b.example/page"]]), text: async () => "" };
    return html("<title>Page</title><p>0123456789</p>");
  };
  const result = await webFetch({ url: "https://a.example/", allow: ["a.example", "b.example"], maxChars: 5, fetchImpl });
  assert.deepEqual(calls, ["https://a.example/", "https://b.example/page"]);
  assert.equal(result.url, "https://b.example/page");
  assert.equal(result.title, "Page");
  assert.equal(result.text, "01234");
  assert.equal(result.truncated, true);

  await assert.rejects(webFetch({ url: "https://a.example/", allow: ["a.example"], fetchImpl }), /not in this role's allowlist/, "redirect target outside the allowlist is refused");
});

test("webFetch refuses non-http schemes and private/loopback addresses", async () => {
  const fetchImpl = async () => html("<p>nope</p>");
  await assert.rejects(webFetch({ url: "file:///etc/passwd", fetchImpl }), /only supports http/);
  await assert.rejects(webFetch({ url: "http://127.0.0.1:4400/", fetchImpl }), /private or loopback/);
  await assert.rejects(webFetch({ url: "http://192.168.1.5/", fetchImpl }), /private or loopback/);
  await assert.rejects(webFetch({ url: "http://localhost/", fetchImpl }), /local hosts/);
  const plain = await webFetch({ url: "https://ok.example/data.json", fetchImpl: async () => html("{\"a\":1}", { "content-type": "application/json" }) });
  assert.equal(plain.text, "{\"a\":1}");
  assert.equal(plain.content_type, "application/json");
});

test("parseSearchResults decodes DuckDuckGo redirect wrappers", () => {
  const page = `
<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">One <b>Title</b></a>
<a class="result__snippet" href="x">First snippet</a></div>
<div class="result results_links"><a class="result__a" href="https://direct.example/two">Two</a><div class="result__snippet">Second</div></div>`;
  assert.deepEqual(parseSearchResults(page), [
    { title: "One Title", url: "https://example.com/one", snippet: "First snippet" },
    { title: "Two", url: "https://direct.example/two", snippet: "Second" }
  ]);
  assert.equal(parseSearchResults(page, 1).length, 1);
});

test("webSearch hits the html endpoint with the encoded query", async () => {
  let seen = "";
  const fetchImpl = async (url) => { seen = url; return html('<div class="result"><a class="result__a" href="https://r.example/">R</a></div>'); };
  const result = await webSearch({ query: "crewrun runtime", fetchImpl });
  assert.equal(seen, "https://html.duckduckgo.com/html/?q=crewrun%20runtime");
  assert.deepEqual(result, { query: "crewrun runtime", results: [{ title: "R", url: "https://r.example/", snippet: "" }] });
  await assert.rejects(webSearch({ query: "  ", fetchImpl }), /needs a query/);
});

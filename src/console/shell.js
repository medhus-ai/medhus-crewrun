import { PAGES } from "./navigation.js";

// The console shell: nav + page frame, server-rendered, zero assets. Follows the
// shell/pages/navigation structure of the first crewrun cockpits, at kernel scale.
export function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const STYLES = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #d7dae0; display: flex; min-height: 100vh; }
nav { width: 190px; padding: 18px 0; background: #14171d; border-right: 1px solid #232833; flex-shrink: 0; }
nav .brand { padding: 0 18px 14px; font-weight: 700; color: #fff; letter-spacing: .02em; }
nav .brand small { display: block; font-weight: 400; color: #8a93a3; font-size: 11px; }
nav a { display: block; padding: 8px 18px; color: #aab2c0; text-decoration: none; }
nav a.active { color: #fff; background: #1d222c; border-left: 2px solid #6ea8fe; padding-left: 16px; }
nav a:hover { color: #fff; }
main { flex: 1; padding: 24px 28px; max-width: 1100px; }
h1 { font-size: 19px; margin: 0 0 4px; color: #fff; }
h2 { font-size: 15px; margin: 22px 0 8px; color: #e8ebf0; }
p.sub { margin: 0 0 18px; color: #8a93a3; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #232833; vertical-align: top; }
th { color: #8a93a3; font-weight: 500; font-size: 12px; }
code, pre { font: 12px/1.5 ui-monospace, monospace; }
pre { background: #14171d; border: 1px solid #232833; border-radius: 6px; padding: 10px 12px; overflow-x: auto; }
textarea { width: 100%; min-height: 220px; background: #14171d; color: #d7dae0; border: 1px solid #232833; border-radius: 6px; padding: 10px; font: 12px/1.5 ui-monospace, monospace; }
input, select { background: #14171d; color: #d7dae0; border: 1px solid #232833; border-radius: 6px; padding: 6px 8px; }
button { background: #1d5fbf; color: #fff; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button.subtle { background: #232833; color: #d7dae0; }
button.danger { background: #7a2733; }
form.inline { display: inline; margin-right: 6px; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; background: #232833; color: #aab2c0; }
.pill.on { background: #14351f; color: #7ed09a; }
.pill.warn { background: #3a2b12; color: #e0b35e; }
.pill.err { background: #3a1620; color: #e07a8d; }
.card { background: #14171d; border: 1px solid #232833; border-radius: 8px; padding: 14px 16px; margin: 0 0 14px; }
.muted { color: #8a93a3; }
.notice { border-left: 3px solid #6ea8fe; padding: 8px 12px; background: #161b24; margin: 0 0 14px; }
footer { margin-top: 26px; color: #5b6372; font-size: 11px; }
`;

export function renderPage(page, content, { targetRoot, version = "" } = {}) {
  const nav = PAGES.map(([id, label]) =>
    `<a href="/${id === "dashboard" ? "" : id}" class="${id === page ? "active" : ""}">${esc(label)}</a>`
  ).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>crewrun console</title><style>${STYLES}</style></head>
<body>
<nav>
  <div class="brand">crewrun<small>${esc(targetRoot)}</small></div>
  ${nav}
</nav>
<main>
${content}
<footer>crewrun console${version ? ` v${esc(version)}` : ""} — local operator surface (127.0.0.1). Configuration is written to the project's .crew/ files.</footer>
</main>
</body></html>`;
}

import { PAGES } from "./navigation.js";

// The console shell is intentionally server rendered and asset-free: hosts can
// embed it without a front-end build, CDN, or browser-side credential boundary.
export function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

const STYLES = `
:root { color-scheme: dark; --bg: #0c0e12; --panel: #13161d; --panel-raised: #181c25; --line: #282e3a; --line-soft: #202630; --text: #edf0f6; --muted: #939dac; --faint: #657081; --blue: #6fa8ff; --blue-strong: #3b82f6; --green: #65d68a; --yellow: #eab762; --red: #f08c9c; }
* { box-sizing: border-box; }
html { background: var(--bg); }
body { min-height: 100vh; margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; }
a { color: inherit; }
nav { position: sticky; top: 0; width: 224px; height: 100vh; overflow-y: auto; padding: 19px 12px; background: #101319; border-right: 1px solid var(--line-soft); flex: 0 0 224px; }
nav .brand { display: flex; align-items: center; gap: 9px; padding: 0 10px 20px; color: #fff; font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
nav .mark { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 6px; background: linear-gradient(145deg, #78afff, #4b74d7); color: #0a1020; font-size: 11px; font-weight: 900; }
nav .project { display: block; padding: 0 10px 16px; color: var(--faint); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
nav .nav-label { padding: 9px 10px 5px; color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
nav a { display: flex; align-items: center; min-height: 33px; margin: 2px 0; padding: 6px 10px; border: 1px solid transparent; border-radius: 7px; color: #aab3c1; text-decoration: none; transition: .12s ease; }
nav a.active { border-color: #2c4e7c; background: #17233a; color: #fff; }
nav a:hover { background: #191e27; color: #fff; }
main { width: min(1320px, 100%); margin: 0 auto; padding: 26px 34px 40px; }
.topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 25px; }
.topbar-meta { min-width: 0; color: var(--muted); font-size: 12px; text-align: right; }
.topbar-meta code { display: block; max-width: 360px; overflow: hidden; color: var(--faint); text-overflow: ellipsis; white-space: nowrap; }
.eyebrow { margin: 0 0 4px; color: var(--blue); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 0; color: #fff; font-size: 25px; line-height: 1.18; letter-spacing: -.025em; }
h2 { margin: 0; color: #eef2f8; font-size: 15px; letter-spacing: -.01em; }
h3 { margin: 0; color: #eef2f8; font-size: 13px; }
p { margin: 0; }
p.sub { margin-top: 7px; color: var(--muted); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 26px 0 10px; }
.section-heading h2 { font-size: 14px; }
.section-heading .muted { font-size: 12px; }
.actions, .button-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.button, button { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; padding: 6px 10px; border: 1px solid #397be5; border-radius: 6px; background: #3376dc; color: #fff; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.button:hover, button:hover { background: #4286ec; }
.button.secondary, button.subtle { border-color: var(--line); background: #202630; color: #dbe1ec; }
.button.secondary:hover, button.subtle:hover { border-color: #3a4555; background: #292f3a; }
.button.danger, button.danger { border-color: #823040; background: #652633; color: #ffe6eb; }
.button.disabled, button:disabled { opacity: .48; cursor: not-allowed; pointer-events: none; }
.button.tiny, button.tiny { min-height: 27px; padding: 4px 8px; font-size: 11px; }
.card { padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); box-shadow: 0 1px 0 rgba(255,255,255,.015) inset; }
.card + .card { margin-top: 12px; }
.card.flat { box-shadow: none; }
.hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; padding: 20px; border: 1px solid #283b58; border-radius: 12px; background: radial-gradient(80% 130% at 0% 0%, #1a2942 0%, #141922 56%, #13161d 100%); }
.hero h1 { font-size: 25px; }
.hero .sub { max-width: 720px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 15px; }
.metric { min-height: 92px; padding: 14px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
.metric .label { display: block; color: var(--muted); font-size: 11px; }
.metric strong { display: block; margin-top: 7px; color: #fff; font-size: 24px; line-height: 1; letter-spacing: -.04em; }
.metric .detail { display: block; margin-top: 6px; color: var(--faint); font-size: 11px; }
.split { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(270px, .9fr); gap: 12px; }
.role-grid, .connector-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
.role-card, .connector-card { display: flex; min-height: 177px; flex-direction: column; padding: 15px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
.role-card.selected { border-color: #477ebf; box-shadow: 0 0 0 1px rgba(90,146,222,.14); }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
.role-name { color: #fff; font-size: 15px; font-weight: 700; }
.role-title { margin-top: 2px; color: var(--muted); font-size: 12px; }
.role-meta { margin-top: 13px; color: var(--muted); font-size: 12px; }
.role-meta > div + div { margin-top: 5px; }
.card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 15px; }
.pill { display: inline-flex; align-items: center; min-height: 20px; padding: 2px 7px; border: 1px solid transparent; border-radius: 999px; background: #222833; color: #aeb7c6; font-size: 10px; font-weight: 650; letter-spacing: .01em; white-space: nowrap; }
.pill.on, .pill.success { border-color: #205832; background: #15391f; color: #7ad496; }
.pill.warn { border-color: #705421; background: #3b2d13; color: #f0c66e; }
.pill.err, .pill.danger { border-color: #75323e; background: #3f1922; color: #f3a0ad; }
.pill.info { border-color: #2e5c93; background: #162d4b; color: #8dbeff; }
.empty { padding: 20px; border: 1px dashed #37404f; border-radius: 9px; color: var(--muted); background: rgba(20,23,29,.62); }
.notice { padding: 10px 12px; border: 1px solid #254d7d; border-radius: 8px; background: #13233a; color: #c6dcfc; font-size: 12px; }
.notice.warn { border-color: #604a1f; background: #302715; color: #eac675; }
.notice + .notice { margin-top: 8px; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { color: #c5d4eb; font-size: .93em; }
pre { margin: 0; padding: 12px; overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: #0f1217; color: #cbd3df; font-size: 12px; line-height: 1.5; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--line-soft); color: #cbd2df; text-align: left; vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: rgba(255,255,255,.012); }
th { color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .055em; text-transform: uppercase; white-space: nowrap; }
td { font-size: 12px; }
.inline { display: inline; }
.inline + .inline { margin-left: 5px; }
form { margin: 0; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px 12px; }
.form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.field { display: grid; gap: 5px; min-width: 0; }
.field.wide { grid-column: 1 / -1; }
label { color: #aeb8c7; font-size: 11px; font-weight: 650; }
input, select, textarea { width: 100%; border: 1px solid #303846; border-radius: 6px; outline: none; background: #0f1218; color: #e4e8ef; font: inherit; font-size: 12px; }
input, select { min-height: 33px; padding: 6px 8px; }
textarea { min-height: 96px; padding: 8px 9px; resize: vertical; line-height: 1.45; }
textarea.code-input { min-height: 190px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
input:focus, select:focus, textarea:focus { border-color: #4f8ceb; box-shadow: 0 0 0 2px rgba(79,140,235,.16); }
.help { color: var(--faint); font-size: 11px; }
.checkbox { display: inline-flex; align-items: center; gap: 7px; color: #c6ceda; font-size: 12px; }
.checkbox input { width: 14px; min-height: 14px; accent-color: #4f8ceb; }
details { margin-top: 16px; border-top: 1px solid var(--line-soft); padding-top: 12px; }
summary { color: var(--muted); cursor: pointer; font-size: 12px; }
.list { display: grid; gap: 8px; }
.list-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line-soft); }
.list-row:last-child { border-bottom: 0; }
.list-row .primary { color: #e7ebf2; font-size: 12px; font-weight: 600; }
.list-row .secondary { margin-top: 2px; color: var(--faint); font-size: 11px; }
.connector-icon { display: grid; width: 29px; height: 29px; place-items: center; border: 1px solid #374251; border-radius: 7px; background: #202630; color: #d7e2f4; font-size: 11px; font-weight: 800; }
.connector-card .description { margin-top: 11px; color: var(--muted); font-size: 12px; }
.connector-card .capabilities { margin-top: 11px; color: var(--faint); font-size: 11px; }
.usage-amount { color: #fff; font-size: 22px; font-weight: 700; letter-spacing: -.035em; }
footer { margin-top: 32px; color: #586272; font-size: 11px; }
@media (max-width: 840px) { body { display: block; } nav { position: static; width: auto; height: auto; padding: 12px; border-right: 0; border-bottom: 1px solid var(--line-soft); } nav .brand { padding: 0 5px 6px; } nav .project, nav .nav-label { display: none; } nav > div:last-child { display: flex; flex-wrap: wrap; gap: 2px; } nav a { display: inline-flex; min-height: 30px; margin: 0; padding: 5px 8px; } main { padding: 20px 16px 34px; } .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .split { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .topbar, .hero { align-items: flex-start; flex-direction: column; } .topbar-meta { text-align: left; } .form-grid, .form-grid.three { grid-template-columns: 1fr; } .summary-grid { gap: 8px; } .metric { min-height: 82px; } th, td { padding: 8px 9px; } }
`;

export function renderPage(page, content, { targetRoot, version = "" } = {}) {
  const nav = PAGES.map(([id, label]) =>
    `<a href="/${id === "dashboard" ? "" : id}" class="${id === page ? "active" : ""}"${id === page ? ' aria-current="page"' : ""}>${esc(label)}</a>`
  ).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>crewrun console</title><style>${STYLES}</style></head>
<body>
<nav>
  <div class="brand"><span class="mark">C</span> crewrun</div>
  <span class="project" title="${esc(targetRoot)}">${esc(targetRoot)}</span>
  <div class="nav-label">Operate</div>
  <div>${nav}</div>
</nav>
<main>
  <header class="topbar">
    <div><p class="eyebrow">Local control plane</p><p class="faint">Governed roles, not an unbounded chat surface.</p></div>
    <div class="topbar-meta">Bound to 127.0.0.1<code title="${esc(targetRoot)}">${esc(targetRoot)}</code></div>
  </header>
${content}
<footer>crewrun console${version ? ` v${esc(version)}` : ""} · configuration is written to this project’s <code>.crew/</code> files.</footer>
</main>
</body></html>`;
}

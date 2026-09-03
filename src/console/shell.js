import { PAGES } from "./navigation.js";

// The console stays fully server-rendered and asset-free. Its icons are small
// inline SVGs so an embedded host does not need a client bundle or icon CDN.
export function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

const NAV_ICONS = Object.freeze({
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  search: '<circle cx="11" cy="11" r="5.5"/><path d="m15.5 15.5 4 4"/>',
  home: '<path d="m3.5 10 8.5-7 8.5 7"/><path d="M5.5 9v10h13V9M9.5 19v-5h5v5"/>',
  cloud: '<path d="M7 18.5h10.2a3.8 3.8 0 0 0 .5-7.6A5.8 5.8 0 0 0 6.5 9.2 4.7 4.7 0 0 0 7 18.5Z"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M8 14h.01M12 14h.01M16 14h.01"/>',
  shield: '<path d="M12 3 19 6v5c0 4.6-3 7.7-7 10-4-2.3-7-5.4-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  network: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="m7.7 7.1 2.8 8M16.3 7.1l-2.8 8M8 6h8"/>',
  blocks: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M15 6l3 3M13 8l3 3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  circle: '<circle cx="12" cy="12" r="7"/>'
});

function icon(name, className = "nav-icon") {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[name] || NAV_ICONS.circle}</svg>`;
}

function workspaceName(root) {
  const value = String(root || "").replace(/[\\/]+$/, "");
  const name = value.split(/[\\/]/).pop() || "Local workspace";
  return name.replace(/[-_]+/g, " ");
}

const STYLES = `
:root { color-scheme: light; --bg: #f5f5f5; --sidebar: #f3f3f3; --sidebar-width: 278px; --panel: #fcfcfc; --panel-raised: #fff; --line: #e2e2e2; --line-soft: #ececec; --text: #171719; --muted: #656b75; --faint: #8a8e96; --blue: #3f6fbe; --blue-strong: #1f5fb8; --green: #237a48; --yellow: #976d19; --red: #b3394d; }
* { box-sizing: border-box; }
html { background: var(--bg); }
body { min-height: 100vh; margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; }
a { color: inherit; }
.sidebar { position: sticky; top: 0; z-index: 2; display: flex; width: var(--sidebar-width); height: 100vh; flex: 0 0 var(--sidebar-width); flex-direction: column; padding: 16px 8px 12px; overflow-y: auto; background: var(--sidebar); border-right: 1px solid var(--line); }
.sidebar-resizer { position: fixed; top: 0; bottom: 0; left: calc(var(--sidebar-width) - 5px); z-index: 3; width: 10px; cursor: col-resize; touch-action: none; }
.sidebar-resizer::before { position: absolute; top: 0; bottom: 0; left: 4px; width: 1px; background: transparent; content: ""; transition: background .12s ease, left .12s ease, width .12s ease; }
.sidebar-resizer:hover::before, .sidebar-resizer:focus-visible::before, .sidebar-resizing .sidebar-resizer::before { left: 3px; width: 3px; background: #91a4bd; }
.sidebar-resizing, .sidebar-resizing * { cursor: col-resize !important; user-select: none; }
.sidebar-top { display: flex; align-items: center; justify-content: space-between; min-height: 25px; padding: 0 9px 14px; }
.back-link { display: inline-flex; width: 20px; height: 20px; align-items: center; justify-content: center; color: #3f4854; text-decoration: none; }
.back-link:hover { color: var(--text); }
.back-link.static { opacity: .72; }
.utility-icon { width: 15px; height: 15px; flex: 0 0 15px; }
.search-glyph { display: inline-flex; color: #66707b; }
.sidebar-nav { display: grid; gap: 10px; }
.nav-group { display: grid; gap: 2px; }
.nav-group + .nav-group { padding-top: 10px; border-top: 1px solid transparent; }
.sidebar-link { display: flex; min-height: 31px; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 6px; color: #22272f; font-size: 14px; text-decoration: none; }
.sidebar-link:hover { background: #e9e9e9; }
.sidebar-link.active { background: #e2e2e2; color: #111214; }
.nav-icon { width: 15px; height: 15px; flex: 0 0 15px; color: #63717d; }
.sidebar-link.active .nav-icon { color: #2e3945; }
.sidebar-account { display: flex; min-height: 48px; align-items: center; gap: 8px; margin-top: auto; padding: 8px 6px; color: #1f2328; }
.workspace-avatar { display: grid; width: 29px; height: 29px; place-items: center; flex: 0 0 29px; border-radius: 50%; background: #ff5b1f; color: #fff; font-size: 13px; font-weight: 650; }
.workspace-copy { min-width: 0; flex: 1; }
.workspace-name { display: block; overflow: hidden; font-size: 12px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.workspace-plan { display: block; color: var(--muted); font-size: 11px; }
.workspace-more { display: inline-flex; color: #59616d; }
main { width: min(1074px, calc(100% - 56px)); min-width: 0; margin: 0 auto; padding: 41px 28px 64px; }
.hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin: 0 0 28px; padding: 0; border: 0; border-radius: 0; background: transparent; }
.hero .eyebrow { display: none; }
h1 { margin: 0; color: #111214; font-size: 21px; font-weight: 580; line-height: 1.24; letter-spacing: -.018em; }
h2 { margin: 0; color: #15171a; font-size: 14px; font-weight: 570; letter-spacing: -.01em; }
h3 { margin: 0; color: #15171a; font-size: 13px; font-weight: 570; }
p { margin: 0; }
p.sub { max-width: 760px; margin-top: 6px; color: #5d6571; font-size: 13px; }
.role-tabs { display: flex; gap: 18px; margin-top: 15px; border-bottom: 1px solid var(--line); }
.role-tab { display: inline-flex; padding: 0 1px 8px; border-bottom: 2px solid transparent; color: var(--muted); font-size: 12px; font-weight: 560; text-decoration: none; }
.role-tab:hover { color: var(--text); }
.role-tab.active { border-color: #1b1c1e; color: #171719; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 32px 0 11px; }
.section-heading h2 { font-size: 14px; }
.section-heading .muted { font-size: 12px; }
.actions, .button-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.button, button { display: inline-flex; min-height: 29px; align-items: center; justify-content: center; padding: 5px 10px; border: 1px solid #1b1c1e; border-radius: 6px; background: #19191a; color: #fff; cursor: pointer; font: inherit; font-size: 12px; font-weight: 550; line-height: 1.3; text-decoration: none; white-space: nowrap; }
.button:hover, button:hover { background: #303033; }
.button.secondary, button.subtle { border-color: #dfdfdf; background: #fff; color: #202124; }
.button.secondary:hover, button.subtle:hover { border-color: #cfcfcf; background: #f8f8f8; }
.button.danger, button.danger { border-color: #d18a95; background: #fdf2f3; color: #9b283c; }
.button.disabled, button:disabled { opacity: .55; cursor: not-allowed; pointer-events: none; }
.button.tiny, button.tiny { min-height: 27px; padding: 4px 8px; font-size: 11px; }
.card { padding: 17px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); box-shadow: none; }
.card + .card { margin-top: 12px; }
.card.flat { box-shadow: none; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 11px; margin-top: 0; }
.metric { min-height: 91px; padding: 15px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.metric .label { display: block; color: #4d5561; font-size: 13px; }
.metric strong { display: block; margin-top: 9px; color: #141518; font-size: 20px; font-weight: 570; line-height: 1; letter-spacing: -.03em; }
.metric strong.success { color: var(--green); }
.metric strong.warn { color: var(--yellow); }
.metric strong.info { color: #274e86; }
.metric .detail { display: block; margin-top: 7px; color: var(--faint); font-size: 11px; }
.split { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(270px, .9fr); gap: 12px; }
.role-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 11px; }
.role-card { display: flex; min-height: 177px; flex-direction: column; padding: 15px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.role-card.selected { border-color: #9eafc8; box-shadow: 0 0 0 1px rgba(76, 113, 166, .12); }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
.role-name { color: #15171a; font-size: 15px; font-weight: 600; }
.role-title { margin-top: 2px; color: var(--muted); font-size: 12px; }
.role-meta { margin-top: 13px; color: var(--muted); font-size: 12px; }
.role-meta > div + div { margin-top: 5px; }
.card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 15px; }
.pill { display: inline-flex; min-height: 20px; align-items: center; padding: 2px 7px; border: 1px solid #e0e0e0; border-radius: 999px; background: #f5f5f5; color: #555c65; font-size: 10px; font-weight: 600; letter-spacing: .01em; white-space: nowrap; }
.pill.on, .pill.success { border-color: #b8dfc4; background: #edf8f0; color: #1e7040; }
.pill.warn { border-color: #ead5a2; background: #fff9e9; color: #805b12; }
.pill.err, .pill.danger { border-color: #efc0c7; background: #fff2f3; color: #a12d42; }
.pill.info { border-color: #c6d5ed; background: #f2f6fc; color: #315b96; }
.empty { padding: 29px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--muted); text-align: center; }
.notice { padding: 10px 12px; border: 1px solid #d4dfef; border-radius: 8px; background: #f5f8fc; color: #355276; font-size: 12px; }
.notice.warn { border-color: #ebdcb7; background: #fff9ed; color: #785e25; }
.notice + .notice { margin-top: 8px; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { color: #33445a; font-size: .92em; }
pre { margin: 0; padding: 12px; overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: #f7f7f7; color: #313743; font-size: 12px; line-height: 1.5; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 11px 14px; border-bottom: 1px solid var(--line-soft); color: #2c323b; text-align: left; vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: #fafafa; }
th { color: #656c76; font-size: 10px; font-weight: 650; letter-spacing: .045em; text-transform: uppercase; white-space: nowrap; }
td { font-size: 12px; }
.inline { display: inline; }
.inline + .inline { margin-left: 5px; }
form { margin: 0; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px 12px; }
.form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.field { display: grid; min-width: 0; gap: 5px; }
.field.wide { grid-column: 1 / -1; }
label { color: #414851; font-size: 11px; font-weight: 600; }
input, select, textarea { width: 100%; border: 1px solid #dcdcdc; border-radius: 6px; outline: none; background: #fff; color: #1d2229; font: inherit; font-size: 12px; }
input, select { min-height: 33px; padding: 6px 8px; }
textarea { min-height: 96px; padding: 8px 9px; resize: vertical; line-height: 1.45; }
textarea.code-input { min-height: 190px; font-family: ui-monospace, SFMono-Regular, monospace; }
input:focus, select:focus, textarea:focus { border-color: #8aaee0; box-shadow: 0 0 0 2px rgba(62, 111, 185, .14); }
.help { color: var(--faint); font-size: 11px; }
.checkbox { display: inline-flex; align-items: center; gap: 7px; color: #343b45; font-size: 12px; }
.checkbox input { width: 14px; min-height: 14px; accent-color: #1f5fb8; }
details { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
summary { color: var(--muted); cursor: pointer; font-size: 12px; }
.list { display: grid; gap: 0; }
.list-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line-soft); }
.list-row:last-child { border-bottom: 0; }
.list-row .primary { color: #252a31; font-size: 12px; font-weight: 570; }
.list-row .secondary { margin-top: 2px; color: var(--faint); font-size: 11px; }
.connector-grid { display: grid; gap: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.connector-card { position: relative; display: flex; min-height: 91px; flex-direction: column; padding: 16px 130px 16px 17px; border: 0; border-bottom: 1px solid var(--line-soft); border-radius: 0; background: transparent; }
.connector-card:last-child { border-bottom: 0; }
.connector-card .card-footer { position: absolute; top: 25px; right: 16px; margin: 0; padding: 0; }
.connector-icon { display: grid; width: 29px; height: 29px; place-items: center; border: 1px solid #e2e2e2; border-radius: 7px; background: #f8f8f8; color: #38495f; font-size: 11px; font-weight: 750; }
.connector-card .description { margin-top: 9px; color: #414954; font-size: 12px; }
.connector-card .capabilities { margin-top: 4px; color: var(--faint); font-size: 11px; }
.usage-amount { color: #15171a; font-size: 22px; font-weight: 600; letter-spacing: -.035em; }
footer { margin-top: 36px; color: #8b9098; font-size: 11px; }
@media (max-width: 850px) { body { display: block; } .sidebar { position: static; width: 100%; height: auto; min-height: 0; flex-direction: row; align-items: center; padding: 8px 10px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); } .sidebar-resizer { display: none; } .sidebar-top { min-height: 0; padding: 0 7px 0 0; } .search-glyph, .sidebar-account { display: none; } .sidebar-nav { display: flex; min-width: max-content; gap: 8px; } .nav-group { display: flex; gap: 2px; } .nav-group + .nav-group { margin: 0; padding: 0; border: 0; } .sidebar-link { width: 34px; min-height: 34px; justify-content: center; padding: 7px; } .sidebar-link .nav-text { display: none; } main { width: min(1074px, calc(100% - 34px)); padding: 29px 0 45px; } .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .split { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .hero { flex-direction: column; gap: 13px; } .form-grid, .form-grid.three { grid-template-columns: 1fr; } .role-grid { grid-template-columns: 1fr; } .summary-grid { gap: 8px; } .metric { min-height: 84px; } .connector-card { padding-right: 16px; } .connector-card .card-footer { position: static; margin-top: 13px; } th, td { padding: 9px 10px; } }
`;

const RESIZER_SCRIPT = `
(() => {
  const sidebar = document.querySelector(".sidebar");
  const handle = document.querySelector(".sidebar-resizer");
  if (!sidebar || !handle || !window.matchMedia("(min-width: 851px)").matches) return;

  const storageKey = "crewrun.console.sidebar-width";
  const defaultWidth = 278;
  const minWidth = 220;
  const maxWidth = () => Math.min(420, Math.max(minWidth, window.innerWidth - 360));
  const clamp = (value) => Math.min(maxWidth(), Math.max(minWidth, Number(value) || defaultWidth));
  const setWidth = (value, persist = false) => {
    const width = Math.round(clamp(value));
    document.documentElement.style.setProperty("--sidebar-width", String(width) + "px");
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuetext", String(width) + " pixels wide");
    if (persist) {
      try { window.localStorage.setItem(storageKey, String(width)); } catch {}
    }
  };

  try {
    const saved = Number(window.localStorage.getItem(storageKey));
    if (saved) setWidth(saved);
  } catch {}

  let activePointer = null;
  const finish = (event) => {
    if (activePointer === null || event.pointerId !== activePointer) return;
    const pointerId = activePointer;
    activePointer = null;
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    document.body.classList.remove("sidebar-resizing");
    setWidth(sidebar.getBoundingClientRect().width, true);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    activePointer = event.pointerId;
    handle.setPointerCapture(activePointer);
    document.body.classList.add("sidebar-resizing");
    event.preventDefault();
  });
  window.addEventListener("pointermove", (event) => {
    if (event.pointerId === activePointer) setWidth(event.clientX - sidebar.getBoundingClientRect().left);
  });
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  handle.addEventListener("lostpointercapture", finish);
  handle.addEventListener("dblclick", () => setWidth(defaultWidth, true));
  handle.addEventListener("keydown", (event) => {
    const current = sidebar.getBoundingClientRect().width;
    const amount = event.shiftKey ? 40 : 16;
    const next = event.key === "ArrowLeft" ? current - amount
      : event.key === "ArrowRight" ? current + amount
        : event.key === "Home" ? minWidth
          : event.key === "End" ? maxWidth()
            : null;
    if (next === null) return;
    event.preventDefault();
    setWidth(next, true);
  });
  window.addEventListener("resize", () => setWidth(sidebar.getBoundingClientRect().width));
})();
`;

export function renderPage(page, content, { targetRoot, version = "", backHref = "", backLabel = "" } = {}) {
  const groups = ["primary", "operations", "account"].map((group) => {
    const links = PAGES.filter((entry) => entry.group === group).map(({ id, label, icon: iconName }) =>
      `<a href="/${id === "dashboard" ? "" : id}" class="sidebar-link${id === page ? " active" : ""}" aria-label="${esc(label)}"${id === page ? ' aria-current="page"' : ""}>${icon(iconName)}<span class="nav-text">${esc(label)}</span></a>`
    ).join("");
    return links ? `<div class="nav-group">${links}</div>` : "";
  }).join("");
  const workspace = workspaceName(targetRoot);
  const initial = workspace.slice(0, 1).toUpperCase() || "C";
  const back = backHref
    ? `<a class="back-link" href="${esc(backHref)}" aria-label="${esc(backLabel || "Back")}" title="${esc(backLabel || "Back")}">${icon("arrowLeft", "utility-icon")}</a>`
    : `<span class="back-link static" aria-hidden="true">${icon("arrowLeft", "utility-icon")}</span>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>crewrun console</title><style>${STYLES}</style></head>
<body>
<aside id="sidebar" class="sidebar">
  <div class="sidebar-top">
    ${back}
    <span class="search-glyph" aria-hidden="true">${icon("search", "utility-icon")}</span>
  </div>
  <div class="sidebar-nav">${groups}</div>
  <div class="sidebar-account" title="${esc(targetRoot)}">
    <span class="workspace-avatar">${esc(initial)}</span>
    <span class="workspace-copy"><span class="workspace-name">${esc(workspace)}</span><span class="workspace-plan">Local workspace</span></span>
    <span class="workspace-more" aria-hidden="true">${icon("more", "utility-icon")}</span>
  </div>
</aside>
<div class="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-controls="sidebar" aria-valuemin="220" aria-valuemax="420" aria-valuenow="278" aria-valuetext="278 pixels wide" tabindex="0" title="Drag to resize the sidebar; double-click to reset"></div>
<main id="main-content">
${content}
<footer>crewrun console${version ? ` v${esc(version)}` : ""} · configuration is written to this project’s <code>.crew/</code> files.</footer>
</main>
<script>${RESIZER_SCRIPT}</script>
</body></html>`;
}

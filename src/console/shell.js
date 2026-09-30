import { PAGES } from "./navigation.js";

// The console stays fully server-rendered and asset-free. Its icons are small
// inline SVGs so an embedded host does not need a client bundle or icon CDN.
export function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

const NAV_ICONS = Object.freeze({
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="5.5"/><path d="m15.5 15.5 4 4"/>',
  home: '<path d="m3.5 10 8.5-7 8.5 7"/><path d="M5.5 9v10h13V9M9.5 19v-5h5v5"/>',
  inbox: '<path d="M3.5 13.5 6 5.5h12l2.5 8"/><path d="M3.5 13.5v5h17v-5h-5l-1.5 2.5h-4l-1.5-2.5Z"/>',
  file: '<path d="M6.5 3.5h7l4 4v13h-11Z"/><path d="M13.5 3.5v4h4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  cloud: '<path d="M7 18.5h10.2a3.8 3.8 0 0 0 .5-7.6A5.8 5.8 0 0 0 6.5 9.2 4.7 4.7 0 0 0 7 18.5Z"/>',
  folder: '<path d="M3.5 6.5h6l1.8 2H20a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V8a1.5 1.5 0 0 1 1-1.5Z"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16M8 14h.01M12 14h.01M16 14h.01"/>',
  shield: '<path d="M12 3 19 6v5c0 4.6-3 7.7-7 10-4-2.3-7-5.4-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  network: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="m7.7 7.1 2.8 8M16.3 7.1l-2.8 8M8 6h8"/>',
  blocks: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  chat: '<path d="M5 18.5 3.7 21l4.1-1.3A8.8 8.8 0 1 0 4 16.1"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-2.35 2.35-.06-.06A1.7 1.7 0 0 0 15.52 19a1.7 1.7 0 0 0-1.02 1.55v.09h-3.32v-.09A1.7 1.7 0 0 0 10.16 19a1.7 1.7 0 0 0-1.87.34l-.06.06-2.35-2.35.06-.06A1.7 1.7 0 0 0 6.28 15a1.7 1.7 0 0 0-1.55-1.02h-.09v-3.32h.09A1.7 1.7 0 0 0 6.28 9.64a1.7 1.7 0 0 0-.34-1.87l-.06-.06 2.35-2.35.06.06a1.7 1.7 0 0 0 1.87.34 1.7 1.7 0 0 0 1.02-1.55v-.09h3.32v.09a1.7 1.7 0 0 0 1.02 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06 2.35 2.35-.06.06a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.55 1.02h.09v3.32h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M15 6l3 3M13 8l3 3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  circle: '<circle cx="12" cy="12" r="7"/>'
});

export function icon(name, className = "nav-icon") {
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
.recent-chats { display: grid; gap: 2px; margin: 5px 0; }
.nav-caption { padding: 4px 10px 2px; color: #8b9098; font-size: 10px; font-weight: 650; letter-spacing: .035em; text-transform: uppercase; }
.sidebar-link.recent-chat { min-height: 28px; font-size: 12px; }
.sidebar-account { display: flex; min-height: 48px; align-items: center; gap: 8px; margin-top: auto; padding: 8px 6px; color: #1f2328; }
.sidebar-account-menu { position: relative; margin-top: auto; }
.sidebar-account-menu .sidebar-account { width: 100%; margin-top: 0; border: 0; border-radius: 7px; background: transparent; cursor: pointer; font: inherit; text-align: left; }
.sidebar-account-menu .sidebar-account:hover { background: #e9e9e9; }
.sidebar-account-menu .sidebar-account:focus-visible { outline: 2px solid #9cb5d9; outline-offset: 2px; }
.sidebar-settings-menu { position: absolute; right: 0; bottom: calc(100% + 7px); left: 0; z-index: 5; display: grid; gap: 2px; padding: 6px; border: 1px solid #dcdfe3; border-radius: 9px; background: #fff; box-shadow: 0 9px 24px rgba(26, 31, 38, .15); }
.sidebar-settings-menu[hidden] { display: none; }
.sidebar-menu-link { display: flex; min-height: 31px; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 6px; color: #252a31; font-size: 12px; text-decoration: none; }
.sidebar-menu-link:hover, .sidebar-menu-link.active { background: #f0f1f2; }
.workspace-avatar { display: grid; width: 29px; height: 29px; place-items: center; flex: 0 0 29px; border-radius: 50%; background: #ff5b1f; color: #fff; font-size: 13px; font-weight: 650; }
.workspace-copy { min-width: 0; flex: 1; }
.workspace-name { display: block; overflow: hidden; font-size: 12px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.workspace-plan { display: block; color: var(--muted); font-size: 11px; }
.workspace-more { display: inline-flex; color: #59616d; }
main { width: min(1074px, calc(100% - 56px)); min-width: 0; margin: 0 auto; padding: 41px 28px 64px; }
.hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin: 0 0 28px; padding: 0; border: 0; border-radius: 0; background: transparent; }
.hero .eyebrow { display: none; }
.hero > .actions { flex: 0 0 auto; }
h1 { margin: 0; color: #111214; font-size: 21px; font-weight: 580; line-height: 1.24; letter-spacing: -.018em; }
h2 { margin: 0; color: #15171a; font-size: 14px; font-weight: 570; letter-spacing: -.01em; }
h3 { margin: 0; color: #15171a; font-size: 13px; font-weight: 570; }
p { margin: 0; }
p.sub { max-width: 760px; margin-top: 6px; color: #5d6571; font-size: 13px; }
.agent-tabs { display: flex; gap: 18px; margin: 15px 0 20px; overflow-x: auto; border-bottom: 1px solid var(--line); }
.agent-tabs > a { white-space: nowrap; }
.task-list { display: grid; gap: 12px; }
.task-list > .card { margin: 0; }
.pagination { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 14px; margin-top: 16px; }
.compact-select { width: auto; min-width: 58px; padding: 4px 8px; }
button.state-toggle { display: inline-flex; width: 34px; min-height: 20px; padding: 2px; border: 0; border-radius: 20px; background: #c6c9cd; }
button.state-toggle::before { content: ""; width: 16px; height: 16px; border-radius: 50%; background: white; margin-right: auto; }
button.state-toggle[aria-checked="true"] { background: var(--green); }
button.state-toggle[aria-checked="true"]::before { margin-right: 0; margin-left: auto; }
button.state-toggle:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
.shell-access h3 { color: var(--red, #c0392b); }
.shell-access button.state-toggle[aria-checked="true"] { background: var(--red, #c0392b); }
.summary-grid > a { text-decoration: none; }
.summary-grid > a:hover { outline: 1px solid var(--line); border-radius: 12px; }
.agent-tab { display: inline-flex; padding: 0 1px 8px; border-bottom: 2px solid transparent; color: var(--muted); font-size: 12px; font-weight: 560; text-decoration: none; }
.agent-tab:hover { color: var(--text); }
.agent-tab.active { border-color: #1b1c1e; color: #171719; }
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
.workspace-files { display: grid; grid-template-columns: minmax(190px, .38fr) minmax(0, 1fr); min-height: 540px; overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.workspace-file-list { overflow: auto; border-right: 1px solid var(--line); padding: 8px; }
.workspace-file-link { display: block; overflow: hidden; padding: 8px 9px; border-radius: 6px; color: var(--text); font-size: 12px; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
.workspace-file-link:hover, .workspace-file-link.active { background: #e9e9e9; }
.workspace-tree { font-size: 12px; }
.workspace-tree .workspace-file-link { display: flex; align-items: center; gap: 6px; padding: 5px 8px; }
.workspace-tree .workspace-file-link span { overflow: hidden; text-overflow: ellipsis; }
.tree-folder { margin: 0; padding: 0; border: 0; }
.tree-folder > summary { display: flex; align-items: center; gap: 5px; padding: 5px 6px; border-radius: 6px; color: var(--text); cursor: pointer; list-style: none; user-select: none; }
.tree-folder > summary::-webkit-details-marker { display: none; }
.tree-folder > summary:hover { background: #e9e9e9; }
.tree-folder > summary span:first-of-type { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.tree-folder[open] > summary .tree-chevron { transform: rotate(90deg); }
.tree-chevron { width: 12px; height: 12px; flex: 0 0 12px; color: var(--faint); transition: transform .12s ease; }
.tree-icon { width: 15px; height: 15px; flex: 0 0 15px; color: var(--muted); }
.tree-count { margin-left: auto; color: var(--faint); font-size: 10px; }
.tree-children { margin-left: 11px; padding-left: 7px; border-left: 1px solid var(--line-soft); }
.tree-empty { margin: 3px 8px 6px; color: var(--faint); font-size: 11px; }
.workspace-crumbs .crumb-sep { margin: 0 4px; color: var(--faint); }
.workspace-preview { min-width: 0; overflow: auto; padding: 22px 25px; }
.workspace-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 18px; }
.workspace-preview-markdown { max-width: 820px; }
.workspace-preview-csv { width: 100%; border-collapse: collapse; font-size: 12px; }
.workspace-preview-csv th, .workspace-preview-csv td { max-width: 330px; overflow-wrap: anywhere; vertical-align: top; }
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
.agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 11px; }
.agent-card { display: flex; min-height: 177px; flex-direction: column; padding: 15px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.agent-card.selected { border-color: #9eafc8; box-shadow: 0 0 0 1px rgba(76, 113, 166, .12); }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
.agent-name { color: #15171a; font-size: 15px; font-weight: 600; }
.agent-title { margin-top: 2px; color: var(--muted); font-size: 12px; }
.agent-mandate { margin-top: 9px; color: var(--text); overflow-wrap: anywhere; }
.connector-setup { width: 100%; }
.connector-setup .field { margin: 10px 0; }
.approval-preview { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow-y: auto; }
.agent-meta { margin-top: 13px; color: var(--muted); font-size: 12px; }
.agent-meta > div + div { margin-top: 5px; }
.card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 15px; }
.icon-button { display: inline-flex; width: 28px; height: 28px; align-items: center; justify-content: center; border: 1px solid #dfdfdf; border-radius: 6px; background: #fff; color: #3d4754; text-decoration: none; }
.icon-button:hover { border-color: #cfcfcf; background: #f8f8f8; color: #171719; }
.icon-button .utility-icon { width: 14px; height: 14px; }
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
.inline-form { display: inline-flex; gap: 6px; align-items: center; margin: 0 6px 0 0; }
.inline-form input[type="password"] { width: 180px; }
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
.connector-card.has-chooser { padding-right: 17px; }
.connector-card.has-chooser .card-footer { position: static; display: block; margin-top: 12px; padding: 0; }
.connector-card:last-child { border-bottom: 0; }
.connector-card .card-footer { position: absolute; top: 25px; right: 16px; margin: 0; padding: 0; }
.connector-icon { display: grid; width: 29px; height: 29px; place-items: center; border: 1px solid #e2e2e2; border-radius: 7px; background: #f8f8f8; color: #38495f; font-size: 11px; font-weight: 750; }
.connector-card .description { margin-top: 9px; color: #414954; font-size: 12px; }
.connector-card .capabilities { margin-top: 4px; color: var(--faint); font-size: 11px; }
.usage-amount { color: #15171a; font-size: 22px; font-weight: 600; letter-spacing: -.035em; }
.calendar-list { overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.calendar-day { display: grid; grid-template-columns: 138px minmax(0, 1fr); border-bottom: 1px solid var(--line-soft); }
.calendar-day:last-child { border-bottom: 0; }
.calendar-date { padding: 15px 16px; color: #313844; font-size: 12px; font-weight: 620; }
.calendar-events { display: grid; gap: 7px; padding: 10px 14px 10px 0; }
.calendar-event { display: grid; gap: 1px; padding: 7px 9px; border: 1px solid #e2e6eb; border-radius: 7px; background: #fff; color: #242a32; font-size: 12px; text-decoration: none; }
.calendar-event:hover { border-color: #bdcce0; background: #fafcff; }
.calendar-event span { color: var(--faint); font-size: 11px; }
.chat-layout { display: grid; height: clamp(520px, calc(100vh - 180px), 760px); min-height: 0; grid-template-columns: 220px minmax(0, 1fr); overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); transition: grid-template-columns .16s ease; }
.chat-layout.threads-collapsed { grid-template-columns: 0 minmax(0, 1fr); }
.chat-threads { display: grid; min-width: 0; align-content: start; gap: 3px; padding: 11px; overflow-y: auto; border-right: 1px solid var(--line); background: #f8f8f8; transition: opacity .12s ease, padding .16s ease; }
.chat-layout.threads-collapsed .chat-threads { padding-right: 0; padding-left: 0; overflow: hidden; border-right: 0; opacity: 0; pointer-events: none; }
.chat-threads-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 7px; padding: 5px 6px 8px; color: #303743; font-size: 12px; }
.chat-threads-title { display: inline-flex; align-items: center; gap: 7px; }
.chat-threads-copy { min-width: 0; }
.chat-threads-copy p { margin: 3px 0 0; color: var(--muted); font-size: 10px; line-height: 1.35; }
.chat-thread { display: grid; min-width: 0; gap: 2px; padding: 8px 9px; border-radius: 7px; color: #2b3139; text-decoration: none; }
.chat-thread:hover { background: #ededed; }
.chat-thread.active { background: #e2e2e2; color: #151719; }
.chat-thread-name { overflow: hidden; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.chat-thread-meta { overflow: hidden; color: var(--faint); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.chat-workspace { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; }
.chat-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 17px 12px; border-bottom: 1px solid var(--line-soft); }
.chat-header p { margin-top: 3px; font-size: 11px; }
.chat-header-title { display: flex; min-width: 0; align-items: flex-start; gap: 8px; }
.chat-header-actions { display: flex; flex: 0 0 auto; gap: 6px; }
.chat-background-work { display: grid; gap: 5px; padding: 8px 17px; border-bottom: 1px solid var(--line-soft); background: #fafbfd; }
.chat-background-work a { display: flex; min-width: 0; align-items: center; gap: 7px; color: #3c4857; font-size: 11px; text-decoration: none; }
.chat-background-work a:hover { color: #171719; text-decoration: underline; }
.chat-show-agents { display: none; flex: 0 0 auto; }
.chat-layout.threads-collapsed .chat-show-agents { display: inline-flex; }
.chat-icon-control { border-color: transparent; background: transparent; }
.chat-icon-control:hover { border-color: transparent; background: #eef0f2; }
.chat-icon-control:focus-visible { outline: 2px solid #9cb5d9; outline-offset: 2px; }
.chat-manage-icon { stroke-width: 2.2; }
.chat-message-pane { position: relative; min-height: 0; flex: 1; overflow: hidden; }
.chat-messages { display: grid; height: 100%; min-height: 0; align-content: start; gap: 12px; padding: 17px; overflow-y: auto; overscroll-behavior: contain; }
.chat-scroll-latest { position: absolute; right: 13px; bottom: 13px; z-index: 1; border-color: transparent; border-radius: 50%; background: #fff; box-shadow: 0 2px 9px rgba(28, 34, 42, .2); }
.chat-scroll-latest:hover { border-color: transparent; background: #f4f6f8; }
.chat-message { max-width: min(700px, 90%); padding: 10px 12px; border: 1px solid #e1e4e8; border-radius: 9px; background: #fff; }
.chat-message.user { justify-self: end; border-color: #cfd9e9; background: #f3f7fd; }
.chat-author { display: block; margin-bottom: 4px; color: #57616d; font-size: 10px; font-weight: 650; }
.chat-copy { overflow-wrap: anywhere; color: #28303a; font-size: 12px; }
.chat-copy > :first-child { margin-top: 0; }
.chat-copy > :last-child { margin-bottom: 0; }
.chat-copy p { margin: 0 0 8px; }
.chat-copy h4, .chat-copy h5, .chat-copy h6 { margin: 12px 0 6px; color: #1f2730; font-size: 12px; }
.chat-copy ul, .chat-copy ol { margin: 6px 0; padding-left: 20px; }
.chat-copy li + li { margin-top: 3px; }
.chat-copy blockquote { margin: 8px 0; padding-left: 9px; border-left: 2px solid #c8d4e3; color: #53606d; }
.chat-copy pre { max-width: 100%; margin: 8px 0; padding: 9px; overflow: auto; border-radius: 7px; background: #f3f5f7; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.chat-copy code { padding: 1px 3px; border-radius: 3px; background: #f0f2f4; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.chat-copy pre code { padding: 0; background: transparent; }
.chat-copy table { width: 100%; margin: 8px 0; font-size: 11px; }
.chat-empty { margin: 17px; padding: 18px; border: 1px dashed #d9dde2; border-radius: 8px; color: var(--muted); font-size: 12px; text-align: center; }
.chat-composer { display: grid; gap: 7px; margin-top: auto; padding: 13px 17px 17px; border-top: 1px solid var(--line-soft); }
.chat-helper-fields { display: flex; flex-wrap: wrap; gap: 6px; }
.chat-helper-fields select, .chat-helper-fields input { width: auto; min-width: 132px; min-height: 29px; padding: 4px 7px; border: 1px solid #d9dde3; border-radius: 7px; background: #fff; color: var(--text); font: inherit; font-size: 11px; }
.chat-composer-field { position: relative; display: flex; align-items: end; min-height: 46px; border: 1px solid #d9dde3; border-radius: 13px; background: #fff; box-shadow: 0 1px 2px rgba(20, 25, 32, .03); transition: border-color .12s ease, box-shadow .12s ease; }
.chat-composer-field:focus-within { border-color: #9cb5d9; box-shadow: 0 0 0 3px rgba(63, 111, 190, .12); }
.chat-composer textarea { min-height: 44px; max-height: 180px; width: 100%; padding: 11px 49px 11px 13px; border: 0; outline: 0; resize: none; background: transparent; color: var(--text); font: inherit; line-height: 1.45; }
.chat-send { position: absolute; right: 8px; bottom: 8px; display: inline-flex; width: 29px; height: 29px; align-items: center; justify-content: center; padding: 0; border: 1px solid #1c1d20; border-radius: 50%; background: #1c1d20; color: #fff; }
.chat-send:hover:not(:disabled) { background: #323338; }
.chat-send:disabled { border-color: #e1e3e6; background: #e1e3e6; color: #9ba1a9; cursor: not-allowed; }
.chat-composer-hint { margin: 0; color: var(--faint); font-size: 10px; }
.chat-message.pending { border-style: dashed; border-color: #c7d4e4; background: #f9fbfd; }
.chat-message.pending .chat-copy { display: flex; align-items: center; gap: 7px; color: #596777; }
.chat-message.pending .chat-copy::before { width: 8px; height: 8px; border: 1.5px solid #8393a5; border-right-color: transparent; border-radius: 50%; content: ""; animation: crewrun-spin .75s linear infinite; }
.chat-message.pending.error { border-color: #dfb6bf; background: #fff8f8; }
.chat-message.pending.error .chat-copy { color: var(--red); }
.chat-message.pending.error .chat-copy::before { border-color: currentColor; border-right-color: transparent; animation: none; }
@keyframes crewrun-spin { to { transform: rotate(360deg); } }
.helper-launcher { position: fixed; right: 20px; bottom: 20px; z-index: 6; display: inline-flex; min-height: 34px; align-items: center; gap: 7px; padding: 7px 11px; border: 1px solid #1c1d20; border-radius: 8px; background: #1c1d20; color: #fff; box-shadow: 0 8px 22px rgba(30, 32, 36, .18); font-size: 12px; font-weight: 600; text-decoration: none; }
.helper-launcher:hover { background: #323338; }
.helper-launcher .utility-icon { color: #fff; }
.helper-drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 7; display: flex; width: min(390px, 100vw); flex-direction: column; border-left: 1px solid var(--line); background: #fcfcfc; box-shadow: -10px 0 30px rgba(25, 28, 33, .12); transform: translateX(102%); transition: transform .16s ease; }
.helper-drawer.open { transform: translateX(0); }
.helper-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 17px; border-bottom: 1px solid var(--line-soft); }
.helper-drawer-head strong { color: #171719; font-size: 14px; }
.helper-drawer-head p { margin-top: 2px; color: var(--muted); font-size: 11px; }
.helper-choices { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 17px 0; }
.helper-choices a { padding: 4px 7px; border: 1px solid #dedede; border-radius: 999px; background: #fff; color: #3d4651; font-size: 11px; text-decoration: none; }
.helper-choices a:hover { border-color: #c7cdd4; background: #f8f8f8; }
.helper-note { margin: 12px 17px; color: var(--muted); font-size: 11px; }
.helper-messages { display: flex; min-height: 0; flex: 1; }
.helper-messages .chat-message-pane { flex: 1; }
.helper-messages .chat-messages { padding-top: 5px; }
.helper-composer { margin: 0; }
footer { margin-top: 36px; color: #8b9098; font-size: 11px; }
@media (max-width: 850px) { body { display: block; } .sidebar { position: static; width: 100%; height: auto; min-height: 0; flex-direction: row; align-items: center; padding: 8px 10px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); } .sidebar-resizer { display: none; } .sidebar-top { min-height: 0; padding: 0 7px 0 0; } .search-glyph, .sidebar-account, .recent-chats { display: none; } .sidebar-nav { display: flex; min-width: max-content; gap: 8px; } .nav-group { display: flex; gap: 2px; } .nav-group + .nav-group { margin: 0; padding: 0; border: 0; } .sidebar-link { width: 34px; min-height: 34px; justify-content: center; padding: 7px; } .sidebar-link .nav-text { display: none; } main { width: min(1074px, calc(100% - 34px)); padding: 29px 0 45px; } .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .split { grid-template-columns: 1fr; } .chat-layout { height: calc(100vh - 145px); grid-template-columns: 185px minmax(0, 1fr); } }
@media (max-width: 560px) { .hero { flex-direction: column; gap: 13px; } .form-grid, .form-grid.three { grid-template-columns: 1fr; } .agent-grid { grid-template-columns: 1fr; } .summary-grid { gap: 8px; } .metric { min-height: 84px; } .connector-card { padding-right: 16px; } .connector-card .card-footer { position: static; margin-top: 13px; } th, td { padding: 9px 10px; } .calendar-day { grid-template-columns: 1fr; } .calendar-date { padding-bottom: 3px; } .calendar-events { padding: 6px 12px 12px; } .workspace-files { grid-template-columns: 1fr; } .workspace-file-list { max-height: 180px; border-right: 0; border-bottom: 1px solid var(--line); } .workspace-preview { padding: 17px; } .chat-layout { height: calc(100vh - 165px); grid-template-columns: 1fr; } .chat-layout.threads-collapsed { grid-template-columns: 1fr; } .chat-threads { grid-template-columns: repeat(2, minmax(0, 1fr)); border-right: 0; border-bottom: 1px solid var(--line); } .chat-layout.threads-collapsed .chat-threads { display: none; } .chat-threads-heading { grid-column: 1 / -1; } .chat-header-actions { gap: 4px; } .chat-header-actions .button { padding-right: 7px; padding-left: 7px; } .helper-launcher { right: 12px; bottom: 12px; } }
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

const CHAT_COMPOSER_SCRIPT = `
(() => {
  for (const menu of document.querySelectorAll("[data-sidebar-menu]")) {
    const toggle = menu.querySelector("[data-sidebar-menu-toggle]");
    const panel = menu.querySelector("[data-sidebar-settings-menu]");
    if (!toggle || !panel) continue;
    const close = () => { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); };
    toggle.addEventListener("click", () => {
      const open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", (event) => { if (!menu.contains(event.target)) close(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  }
  for (const pane of document.querySelectorAll(".chat-message-pane")) {
    const messages = pane.querySelector(".chat-messages");
    const latest = pane.querySelector("[data-chat-scroll-latest]");
    if (!messages || !latest) continue;
    const atBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 24;
    const update = () => { latest.hidden = atBottom(); };
    const scrollLatest = (behavior) => { messages.scrollTo({ top: messages.scrollHeight, behavior }); update(); };
    requestAnimationFrame(() => scrollLatest("auto"));
    messages.addEventListener("scroll", update, { passive: true });
    latest.addEventListener("click", () => scrollLatest("smooth"));
    update();
  }
  for (const toggle of document.querySelectorAll("[data-chat-threads-toggle]")) {
    const layout = toggle.closest(".chat-layout");
    if (!layout) continue;
    toggle.addEventListener("click", () => {
      const collapsed = toggle.dataset.chatThreadsToggle === "hide";
      layout.classList.toggle("threads-collapsed", collapsed);
      for (const control of layout.querySelectorAll("[data-chat-threads-toggle]")) control.setAttribute("aria-expanded", String(!collapsed));
    });
  }
  for (const form of document.querySelectorAll("form.chat-composer")) {
    const field = form.querySelector('textarea[name="message"]');
    const send = form.querySelector('button[type="submit"]');
    if (!field || !send) continue;
    let submitting = false;
    const resize = () => {
      field.style.height = "auto";
      field.style.height = Math.min(field.scrollHeight, 180) + "px";
      field.style.overflowY = field.scrollHeight > 180 ? "auto" : "hidden";
    };
    const update = () => { send.disabled = !field.value.trim(); resize(); };
    field.addEventListener("input", update);
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!send.disabled) form.requestSubmit();
      }
    });
    const appendMessage = (author, message, pending = false) => {
      const scope = form.closest(".chat-workspace") || form.closest(".helper-drawer");
      if (!scope) return null;
      const pane = scope.querySelector(".chat-message-pane") || scope;
      let messages = pane.querySelector(".chat-messages");
      if (!messages) {
        pane.querySelector(".chat-empty")?.remove();
        messages = document.createElement("div");
        messages.className = "chat-messages";
        pane.append(messages);
      }
      const item = document.createElement("article");
      item.className = "chat-message" + (author === "You" ? " user" : "") + (pending ? " pending" : "");
      const label = document.createElement("span"); label.className = "chat-author"; label.textContent = author;
      const copy = document.createElement("div"); copy.className = "chat-copy"; copy.textContent = message;
      item.append(label, copy); messages.append(item); item.scrollIntoView({ block: "nearest" });
      return { item, copy };
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = field.value.trim();
      if (!message || submitting) { field.focus(); return; }
      submitting = true;
      appendMessage("You", message);
      const pending = appendMessage(form.dataset.responseLabel || "Agent", "Thinking…", true);
      field.value = ""; field.disabled = true; update();
      try {
        const body = new URLSearchParams(new FormData(form));
        body.set("message", message);
        const response = await fetch(form.action, { method: "POST", body });
        if (!response.ok) throw new Error("The message could not be sent.");
        window.location.assign(response.url || window.location.href);
      } catch (error) {
        submitting = false; field.disabled = false; update();
        if (pending) { pending.item.classList.add("error"); pending.copy.textContent = error?.message || "Connection lost. Reload before trying again."; }
      }
    });
    update();
  }
})();
`;

export function renderPage(page, content, { targetRoot, version = "", backHref = "", backLabel = "", recentChats = [], inboxCount = 0, helperContent = "" } = {}) {
  // Pages without their own sidebar entry highlight the item whose tabs contain them.
  const activeId = PAGES.find((entry) => entry.id === page)?.navParent || page;
  const sidebarLink = ({ id, label, icon: iconName }) =>
    `<a href="/${id}" class="sidebar-link${id === activeId ? " active" : ""}" aria-label="${esc(label)}"${id === activeId ? ' aria-current="page"' : ""}>${icon(iconName)}<span class="nav-text">${esc(label)}</span>${id === "inbox" && inboxCount ? `<span class="pill" aria-label="${esc(inboxCount)} items need you">${esc(inboxCount)}</span>` : ""}</a>`;
  const chats = Array.isArray(recentChats)
    ? recentChats.filter((chat) => /^[a-z][a-z0-9-]{0,79}$/.test(String(chat?.role || "")) && chat.purpose !== "console-helper").slice(0, 6)
    : [];
  const groups = ["primary", "operations", "communication"].map((group) => {
    const entries = PAGES.filter((entry) => entry.group === group && entry.nav !== false);
    const links = `${entries.map(sidebarLink).join("")}${group === "communication" && chats.length ? `<div class="recent-chats"><span class="nav-caption">Recent chats</span>${chats.map((chat) => `<a href="/chats?agent=${encodeURIComponent(chat.role)}" class="sidebar-link recent-chat" aria-label="Open chat: ${esc(chat.title || chat.role)}"><span class="nav-text">${esc(chat.title || chat.role)}</span></a>`).join("")}</div>` : ""}`;
    return links ? `<div class="nav-group">${links}</div>` : "";
  }).join("");
  const accountLinks = PAGES.filter((entry) => entry.group === "account").map(({ id, label, icon: iconName }) =>
    `<a href="/${id}" class="sidebar-menu-link${id === page ? " active" : ""}" aria-label="${esc(label)}"${id === page ? ' aria-current="page"' : ""}>${icon(iconName)}<span>${esc(label)}</span></a>`
  ).join("");
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
  <div class="sidebar-account-menu" data-sidebar-menu>
    <button class="sidebar-account" type="button" data-sidebar-menu-toggle aria-expanded="false" aria-controls="sidebar-settings-menu" title="Workspace menu">
      <span class="workspace-avatar">${esc(initial)}</span>
      <span class="workspace-copy"><span class="workspace-name">${esc(workspace)}</span><span class="workspace-plan">Local workspace</span></span>
      <span class="workspace-more" aria-hidden="true">${icon("more", "utility-icon")}</span>
    </button>
    <div id="sidebar-settings-menu" class="sidebar-settings-menu" data-sidebar-settings-menu hidden>${accountLinks}</div>
  </div>
</aside>
<div class="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-controls="sidebar" aria-valuemin="220" aria-valuemax="420" aria-valuenow="278" aria-valuetext="278 pixels wide" tabindex="0" title="Drag to resize the sidebar; double-click to reset"></div>
<main id="main-content">
${content}
</main>
${helperContent}
<script>${RESIZER_SCRIPT}${CHAT_COMPOSER_SCRIPT}</script>
</body></html>`;
}

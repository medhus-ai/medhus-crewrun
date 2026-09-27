// Keep navigation as data: the server-rendered shell can supply purposeful
// inline icons without bringing a browser-side icon dependency into a host.
// `nav: false` pages stay routable but are reached from another item's tabs
// (`navParent` marks which sidebar item is highlighted for them).
export const PAGES = [
  { id: "inbox", label: "Inbox", icon: "inbox", group: "primary" },
  { id: "workspace", label: "Workspace", icon: "folder", group: "primary" },
  { id: "scheduled", label: "Scheduled", icon: "calendar", group: "primary" },
  { id: "agents", label: "Agents", icon: "cloud", group: "operations" },
  { id: "integrations", label: "Integrations & Skills", icon: "network", group: "operations" },
  { id: "skills", label: "Skills", icon: "blocks", group: "operations", nav: false, navParent: "integrations" },
  { id: "activity", label: "Activity", icon: "list", group: "operations" },
  { id: "usage", label: "Usage", icon: "chart", group: "account" },
  { id: "settings", label: "Settings", icon: "key", group: "account" },
  { id: "chats", label: "Chats", icon: "chat", group: "communication" }
];

export function pageFromUrl(pathname) {
  const clean = String(pathname || "/").split("?")[0].replace(/\/+$/, "") || "/";
  if (clean === "/") return "inbox";
  const id = clean.slice(1).split("/")[0];
  return PAGES.some((page) => page.id === id) ? id : "";
}

// Dashboard, Tasks and Reviews were merged into Inbox. Old links (bookmarks,
// notifications, host redirects) keep working by mapping to the matching view.
export function legacyInboxRedirect(url) {
  const clean = url.pathname.replace(/\/+$/, "") || "/";
  const params = url.searchParams;
  const target = (query) => `/inbox${query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`;
  if (clean === "/dashboard") return "/inbox";
  if (clean === "/tasks") {
    const run = params.get("run");
    if (run) return target({ run });
    const tab = { attention: "attention", active: "progress", completed: "done", all: "done" }[params.get("tab")] || "attention";
    return target({ tab });
  }
  if (clean === "/reviews") {
    const tab = params.get("tab") || "actions";
    const review = params.get("review");
    const run = params.get("run");
    if (tab === "results") return run ? target({ run }) : target({ tab: "attention" });
    if (tab === "history") return target({ tab: "done" });
    return target({ tab: "approvals", ...(review ? { review } : {}) });
  }
  return "";
}

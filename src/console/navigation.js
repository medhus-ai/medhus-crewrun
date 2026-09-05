// Keep navigation as data: the server-rendered shell can supply purposeful
// inline icons without bringing a browser-side icon dependency into a host.
export const PAGES = [
  { id: "dashboard", label: "Dashboard", icon: "home", group: "primary" },
  { id: "tasks", label: "Tasks", icon: "list", group: "primary" },
  { id: "agents", label: "Agents", icon: "cloud", group: "primary" },
  { id: "scheduled", label: "Scheduled", icon: "calendar", group: "primary" },
  { id: "approvals", label: "Approvals", icon: "shield", group: "operations" },
  { id: "audit", label: "Audit", icon: "list", group: "operations" },
  { id: "connectors", label: "Integrations", icon: "network", group: "operations" },
  { id: "skills", label: "Skills", icon: "blocks", group: "operations" },
  { id: "providers", label: "Providers", icon: "key", group: "account" },
  { id: "usage", label: "Usage", icon: "chart", group: "account" }
];

export function pageFromUrl(pathname) {
  const clean = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (clean === "/") return "dashboard";
  const id = clean.slice(1).split("/")[0];
  // Keep old bookmarks useful now that governance proposals live on the broader
  // approval queue page.
  if (id === "proposals") return "approvals";
  // Old console bookmarks remain valid while the UI calls these Scheduled tasks.
  if (id === "roles") return "agents";
  if (id === "schedules") return "scheduled";
  return PAGES.some((page) => page.id === id) ? id : "";
}

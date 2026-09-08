// Keep navigation as data: the server-rendered shell can supply purposeful
// inline icons without bringing a browser-side icon dependency into a host.
export const PAGES = [
  { id: "dashboard", label: "Dashboard", icon: "home", group: "primary" },
  { id: "tasks", label: "Tasks", icon: "list", group: "primary" },
  { id: "reviews", label: "Reviews", icon: "shield", group: "primary" },
  { id: "scheduled", label: "Scheduled", icon: "calendar", group: "primary" },
  { id: "agents", label: "Agents", icon: "cloud", group: "operations" },
  { id: "skills", label: "Skills", icon: "blocks", group: "operations" },
  { id: "integrations", label: "Integrations", icon: "network", group: "operations" },
  { id: "activity", label: "Activity", icon: "list", group: "operations" },
  { id: "chats", label: "Chats", icon: "chat", group: "account" },
  { id: "usage", label: "Usage", icon: "chart", group: "account" },
  { id: "settings", label: "Settings", icon: "key", group: "account" }
];

export function pageFromUrl(pathname) {
  const clean = String(pathname || "/").split("?")[0].replace(/\/+$/, "") || "/";
  if (clean === "/") return "dashboard";
  const id = clean.slice(1).split("/")[0];
  return PAGES.some((page) => page.id === id) ? id : "";
}

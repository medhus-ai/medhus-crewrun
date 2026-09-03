export const PAGES = [
  ["dashboard", "Dashboard"],
  ["roles", "Roles"],
  ["schedules", "Schedules"],
  ["approvals", "Approvals"],
  ["audit", "Audit"],
  ["usage", "Usage"],
  ["providers", "Providers"],
  ["connectors", "Connectors"],
  ["skills", "Skills"]
];

export function pageFromUrl(pathname) {
  const clean = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (clean === "/") return "dashboard";
  const id = clean.slice(1).split("/")[0];
  // Keep old bookmarks useful now that governance proposals live on the broader
  // approval queue page.
  if (id === "proposals") return "approvals";
  return PAGES.some(([page]) => page === id) ? id : "";
}

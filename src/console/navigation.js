export const PAGES = [
  ["dashboard", "Dashboard"],
  ["roles", "Roles"],
  ["schedules", "Schedules"],
  ["skills", "Skills"],
  ["proposals", "Proposals"]
];

export function pageFromUrl(pathname) {
  const clean = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (clean === "/") return "dashboard";
  const id = clean.slice(1).split("/")[0];
  return PAGES.some(([page]) => page === id) ? id : "";
}

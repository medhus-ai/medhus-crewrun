import { readFileSync } from "node:fs";
import path from "node:path";

import { crewDir } from "./crew-dirs.js";

// Callback form disables $&/$$/$n special-replacement patterns in values.
export function interpolate(text, vars) {
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`__${k}__`, () => String(v)),
    text
  );
}

// Reads templates from one directory. __CREW_DIR__ is always substituted so no template
// hardcodes the directory name; hosts add their own placeholder substitutions and ship their
// own memory files (engineering doctrine, conventions) — the runtime has no opinion on those.
export function createTemplateReader(dir, { substitutions = {} } = {}) {
  return function readTemplate(rel) {
    let text = readFileSync(path.join(dir, rel), "utf8").replaceAll("__CREW_DIR__", crewDir());
    for (const [placeholder, value] of Object.entries(substitutions)) {
      text = text.replaceAll(placeholder, () => String(value));
    }
    return text;
  };
}


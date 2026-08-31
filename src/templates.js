import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CREW_DIR } from "./crew-dirs.js";

const KERNEL_TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

// Callback form disables $&/$$/$n special-replacement patterns in values.
export function interpolate(text, vars) {
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`__${k}__`, () => String(v)),
    text
  );
}

// Reads templates from one directory. __CREW_DIR__ is always substituted so no template
// hardcodes the directory name; hosts add their own placeholder substitutions.
export function createTemplateReader(dir, { substitutions = {} } = {}) {
  return function readTemplate(rel) {
    let text = readFileSync(path.join(dir, rel), "utf8").replaceAll("__CREW_DIR__", CREW_DIR);
    for (const [placeholder, value] of Object.entries(substitutions)) {
      text = text.replaceAll(placeholder, () => String(value));
    }
    return text;
  };
}

export const readKernelTemplate = createTemplateReader(KERNEL_TEMPLATES);

// Doctrine every crew shares; hosts install it as <CREW_DIR>/memory/lean-engineering.md.
export const leanEngineeringTemplate = readKernelTemplate("memory/lean-engineering.md");

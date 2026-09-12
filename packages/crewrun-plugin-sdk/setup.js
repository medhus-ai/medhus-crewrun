import { createPrivateKey } from "node:crypto";

// Public setup describes fields, never their values. Only the private host may store them.
export function normalizePluginSetup(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.fields)) throw new Error("plugin setup needs fields");
  const seen = new Set();
  const fields = raw.fields.map((field) => {
    const key = String(field.key || "");
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key) || ["constructor", "prototype"].includes(key) || seen.has(key)) throw new Error("invalid or duplicate setup field");
    seen.add(key);
    const type = field.type || "secret";
    if (!["text", "secret", "pem"].includes(type)) throw new Error("invalid setup field type");
    return { key, label: String(field.label || key).slice(0, 160), type, required: field.required === true,
      alternatives: (field.alternatives || []).map((key) => {
        if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key) || ["constructor", "prototype"].includes(key)) throw new Error("invalid setup alternative");
        return key;
      }), help: String(field.help || "").slice(0, 1024) };
  });
  const docsUrl = new URL(raw.docsUrl);
  if (docsUrl.protocol !== "https:" || docsUrl.username || docsUrl.password) throw new Error("setup docsUrl must use HTTPS");
  return { fields, docsUrl: docsUrl.href, instructions: String(raw.instructions || "").slice(0, 4096) };
}

export function pluginSetupStatus(plugin, config = {}, external = {}) {
  const fields = (plugin.setup?.fields || []).map((field) => ({
    ...field,
    configured: Boolean(config[field.key] || field.alternatives.some((key) => config[key])),
    locked: Boolean(external[field.key] || field.alternatives.some((key) => external[key]))
  }));
  const configured = plugin.setup ? fields.every((field) => !field.required || field.configured)
    : !plugin.oauth || Boolean(config.clientId);
  return { configured, fields, message: configured ? "" : "Set up this provider app before connecting." };
}

export function pluginSetupPatch(plugin, input = {}, external = {}) {
  if (!plugin.setup) throw new Error("This plugin does not declare console setup.");
  const patch = {};
  for (const field of plugin.setup.fields) {
    const value = input[field.key];
    if (value == null || value === "") continue; // Blank fields retain stored credentials.
    if (typeof value !== "string" || value.length > 32_768) throw new Error("Invalid setup field value.");
    if (external[field.key] || field.alternatives.some((key) => external[key])) throw new Error("This field is managed by the host environment.");
    if (field.type === "pem") {
      try { createPrivateKey(value); } catch { throw new Error("Provide a valid unencrypted PEM private key."); }
    }
    patch[field.key] = value.trim();
  }
  return patch;
}

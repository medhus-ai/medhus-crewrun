import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Isolate every file this suite writes before the modules resolve their paths.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "crew-local-models-"));
process.env.CREW_HOME = path.join(tmpRoot, "crew-home");
process.env.CREW_RUNNERS_FILE = path.join(tmpRoot, "ai-runners.json");
process.env.CREW_SECRETS_FILE = path.join(tmpRoot, "secrets.json");
delete process.env.ANTHROPIC_API_KEY;

const local = await import("../src/local-models.js");
const store = await import("../src/secret-store.js");
const { createConsole } = await import("../src/console/server.js");
const { agentRunnerProfiles, runnerCatalog } = await import("../src/runner-config.js");

after(async () => {
  store.resetSecretStoreForTests();
  await rm(tmpRoot, { recursive: true, force: true });
});

const mac = (memoryGb) => ({ platform: "darwin", arch: "arm64", unifiedMemory: true, memoryGb, gpus: [], vramGb: 0, freeDiskGb: 500 });
const pc = (memoryGb, vramGb = 0, freeDiskGb = 500) => ({ platform: "linux", arch: "x64", unifiedMemory: false, memoryGb, gpus: vramGb ? [{ name: "GPU", memoryGb: vramGb }] : [], vramGb, freeDiskGb });

test("each platform gets exactly one supported runtime", () => {
  assert.equal(local.runtimeForPlatform({ platform: "darwin", arch: "arm64" }).id, "omlx");
  assert.equal(local.runtimeForPlatform({ platform: "darwin", arch: "x64" }), null, "Intel Macs are not supported");
  assert.equal(local.runtimeForPlatform({ platform: "linux", arch: "x64" }).id, "llama-cpp");
  assert.equal(local.runtimeForPlatform({ platform: "win32", arch: "x64" }).id, "llama-cpp");
});

test("nvidia-smi output parses into GPU memory", () => {
  assert.deepEqual(local.parseNvidiaSmi("NVIDIA GeForce RTX 5090, 32607\nNVIDIA RTX A1000, 8188\n\n"), [
    { name: "NVIDIA GeForce RTX 5090", memoryGb: 34.2 },
    { name: "NVIDIA RTX A1000", memoryGb: 8.6 }
  ]);
  assert.deepEqual(local.parseNvidiaSmi("garbage"), []);
});

test("recommendations follow memory, GPU and disk", () => {
  const pick = (hardware) => local.recommendLocalModels(hardware, local.runtimeForPlatform(hardware)).recommended;
  assert.equal(pick(mac(16)), "gemma-4-e4b");
  assert.equal(pick(mac(32)), "qwen3.8-27b");
  assert.equal(pick(mac(48)), "qwen3.6-35b-a3b");
  assert.equal(pick(mac(128)), "gpt-oss-120b");
  assert.equal(pick(mac(8)), "", "nothing fits an 8 GB Mac");
  assert.equal(pick(pc(64, 24)), "qwen3.8-27b", "a 24 GB GPU runs the dense model fully on the GPU");
  assert.equal(pick(pc(32)), "gpt-oss-20b", "CPU-only machines get a mixture-of-experts model");
  assert.equal(pick(pc(64, 24, 15)), "gpt-oss-20b", "free disk rules out the larger downloads");

  const cpuOnly = local.recommendLocalModels(pc(128), local.LOCAL_RUNTIMES["llama-cpp"]);
  const dense = cpuOnly.options.find((option) => option.model.id === "qwen3.8-27b");
  assert.equal(dense.fit, null);
  assert.match(dense.fitLabel, /needs a larger GPU/);
  const moe = local.recommendLocalModels(pc(64, 8), local.LOCAL_RUNTIMES["llama-cpp"]).options.find((option) => option.model.id === "qwen3.6-35b-a3b");
  assert.equal(moe.fit, "gpu+ram");
  assert.match(local.setupSteps(local.LOCAL_RUNTIMES["llama-cpp"], moe.model, { fit: moe.fit, platform: "linux" })[1].command, /--n-cpu-moe/);
});

test("setup steps name the runtime's own tools", () => {
  const model = local.catalogModel("gpt-oss-20b");
  const llama = local.setupSteps(local.LOCAL_RUNTIMES["llama-cpp"], model, { platform: "win32" });
  assert.equal(llama[0].command, "winget install llama.cpp");
  assert.match(llama[1].command, /^llama-server -hf ggml-org\/gpt-oss-20b-GGUF:MXFP4 --alias gpt-oss-20b --jinja /);
  assert.match(llama[1].command, /--host 127\.0\.0\.1/);
  const omlx = local.setupSteps(local.LOCAL_RUNTIMES.omlx, model);
  assert.match(omlx[0].command, /brew install jundot\/omlx\/omlx/);
  assert.match(omlx[1].command, /hf download mlx-community\/gpt-oss-20b-MXFP4-Q8/);
  assert.match(omlx[2].command, /omlx serve --model-dir ~\/\.crew\/models\/mlx --port 8000/);
});

test("server addresses are normalized and credentials are refused", () => {
  assert.equal(local.normalizeBaseUrl("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080");
  assert.equal(local.normalizeBaseUrl(" http://gpu-box.lan:8000 "), "http://gpu-box.lan:8000");
  assert.throws(() => local.normalizeBaseUrl("file:///etc/passwd"), /http/);
  assert.throws(() => local.normalizeBaseUrl("http://user:pass@127.0.0.1:8080"), /credentials/);
  assert.throws(() => local.normalizeBaseUrl("not a url"), /server address/);
});

function fakeFetch({ models = ["gpt-oss-20b"], messages = 200, toolUse = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/v1/models")) return Response.json({ data: models.map((id) => ({ id })) });
    if (messages !== 200) return new Response("nope", { status: messages });
    const body = JSON.parse(init.body);
    const content = body.tools && toolUse
      ? [{ type: "tool_use", id: "t1", name: "record_answer", input: { answer: "4" } }]
      : [{ type: "text", text: "OK" }];
    return Response.json({ type: "message", role: "assistant", content });
  };
  return { fetchImpl, calls };
}

test("a server check needs models, messages and reports tool use", async () => {
  const good = fakeFetch();
  const ok = await local.checkLocalServer({ baseUrl: "http://127.0.0.1:8080", fetchImpl: good.fetchImpl });
  assert.equal(ok.ok, true);
  assert.equal(ok.tools, true);
  assert.equal(ok.model, "gpt-oss-20b", "defaults to the first listed model");
  assert.deepEqual(good.calls.map((call) => new URL(call.url).pathname), ["/v1/models", "/v1/messages", "/v1/messages"]);
  assert.equal(good.calls[2].body.tools[0].name, "record_answer");

  const noTools = await local.checkLocalServer({ baseUrl: "http://127.0.0.1:8080", fetchImpl: fakeFetch({ toolUse: false }).fetchImpl });
  assert.equal(noTools.ok, true);
  assert.equal(noTools.tools, false);
  assert.match(noTools.detail, /--jinja/);

  const openAiOnly = await local.checkLocalServer({ baseUrl: "http://127.0.0.1:8080", fetchImpl: fakeFetch({ messages: 404 }).fetchImpl });
  assert.equal(openAiOnly.ok, false);
  assert.match(openAiOnly.detail, /Anthropic Messages API/);

  const empty = await local.checkLocalServer({ baseUrl: "http://127.0.0.1:8080", fetchImpl: fakeFetch({ models: [] }).fetchImpl });
  assert.equal(empty.ok, false);
  assert.match(empty.detail, /lists no models/);

  const down = await local.checkLocalServer({ baseUrl: "http://127.0.0.1:1", fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } });
  assert.equal(down.ok, false);
  assert.match(down.detail, /Start the local model server/);
});

test("saved local runners are assignable profiles and can be removed", async () => {
  const runner = local.saveLocalRunner({ baseUrl: "http://127.0.0.1:8080", model: "gpt-oss-20b", runtime: "llama-cpp", check: { ok: true, tools: true, detail: "fine" } });
  assert.equal(runner.id, "local-gpt-oss-20b");
  assert.equal(runner.display_name, "Local · gpt-oss 20B");
  const saved = JSON.parse(await readFile(process.env.CREW_RUNNERS_FILE, "utf8"));
  assert.equal(saved.runners[0].base_url, "http://127.0.0.1:8080");
  assert.equal(saved.runners[0].engine, "claude-agent");
  assert.equal(saved.runners[0].last_check.tools, true);
  const localGroup = runnerCatalog().find((group) => group.provider === "local");
  assert.ok(localGroup?.models.some((model) => model.model === "gpt-oss-20b"), "the agent model picker lists the local runner");
  // Saving again replaces the entry rather than duplicating it.
  local.saveLocalRunner({ baseUrl: "http://127.0.0.1:8081", model: "gpt-oss-20b" });
  assert.equal(local.listLocalRunners().length, 1);
  assert.equal(local.listLocalRunners()[0].base_url, "http://127.0.0.1:8081");
  assert.equal(local.removeLocalRunner("local-gpt-oss-20b"), true, "removing the last runner is allowed");
  assert.deepEqual(local.listLocalRunners(), []);
  assert.equal(local.removeLocalRunner("claude-agent-sonnet-high"), false, "only local runners are removed here");
  assert.ok(agentRunnerProfiles().some((profile) => profile.id === "claude-agent-sonnet-high"));
});

async function workspace() {
  const root = path.join(tmpRoot, `repo-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(root, ".crew", "agents"), { recursive: true });
  await writeFile(path.join(root, ".crew", "agents", "_defaults.json"), JSON.stringify({ runner: "claude-agent-sonnet-high" }), "utf8");
  return root;
}

const message = (response) => new URL(response.headers.get("location"), "http://console").searchParams.get("message") || "";

function post(base, pathname, fields) {
  return fetch(base + pathname, { method: "POST", redirect: "manual", headers: { Origin: base }, body: new URLSearchParams(fields) });
}

test("Settings creates, unlocks, fills and locks the encrypted key store", async () => {
  store.resetSecretStoreForTests();
  const root = await workspace();
  const console_ = createConsole({ targetRoot: root, port: 0 });
  try {
    const base = `http://127.0.0.1:${await console_.listen()}`;
    let page = await (await fetch(base + "/settings")).text();
    assert.match(page, /Create key store/);
    assert.match(page, /This console is not running your crew/, "a standalone console says keys need the running crew");

    let response = await post(base, "/settings/secrets/create", { password: "short", confirm: "short" });
    assert.match(message(response), /at least 8 characters/);
    response = await post(base, "/settings/secrets/create", { password: "correct horse 9", confirm: "different pass" });
    assert.match(message(response), /do not match/);
    response = await post(base, "/settings/secrets/create", { password: "correct horse 9", confirm: "correct horse 9" });
    assert.equal(response.status, 303);
    assert.equal(store.isUnlocked(), true);

    response = await post(base, "/settings/secrets/set", { name: "OPENROUTER_API_KEY", value: "sk-or-secret-1234" });
    assert.match(response.headers.get("location"), /status=ok/);
    response = await post(base, "/settings/secrets/set", { name: "../../evil", value: "x" });
    assert.match(response.headers.get("location"), /status=error/, "only known provider keys can be set here");
    page = await (await fetch(base + "/settings")).text();
    assert.match(page, /saved ••••1234/);
    assert.doesNotMatch(page, /sk-or-secret/, "the page never shows a saved key");
    const sealed = await readFile(process.env.CREW_SECRETS_FILE, "utf8");
    assert.doesNotMatch(sealed, /sk-or-secret/);

    await post(base, "/settings/secrets/lock", {});
    assert.equal(store.isUnlocked(), false);
    page = await (await fetch(base + "/settings")).text();
    assert.match(page, />Unlock</);
    response = await post(base, "/settings/secrets/unlock", { password: "wrong password" });
    assert.match(message(response), /Wrong password/);
    response = await post(base, "/settings/secrets/unlock", { password: "correct horse 9" });
    assert.match(response.headers.get("location"), /status=ok/);
    assert.equal(store.getSecret("OPENROUTER_API_KEY"), "sk-or-secret-1234");
    await post(base, "/settings/secrets/remove", { name: "OPENROUTER_API_KEY" });
    assert.equal(store.getSecret("OPENROUTER_API_KEY"), undefined);

    const blocked = await fetch(base + "/settings/secrets/lock", { method: "POST", headers: { Origin: "https://evil.test" }, body: "" });
    assert.equal(blocked.status, 403, "cross-origin key-store changes are refused");
  } finally {
    await console_.close();
    store.resetSecretStoreForTests();
  }
});

test("Settings → Local models checks a running server and connects it", async () => {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    seen.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") return response.end(JSON.stringify({ data: [{ id: "qwen3.6-35b-a3b" }] }));
    const body = JSON.parse(raw);
    return response.end(JSON.stringify({ content: body.tools ? [{ type: "tool_use", id: "t", name: "record_answer", input: {} }] : [{ type: "text", text: "OK" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await workspace();
  const console_ = createConsole({ targetRoot: root, port: 0 });
  try {
    const base = `http://127.0.0.1:${await console_.listen()}`;
    let page = await (await fetch(base + "/settings?tab=local")).text();
    assert.match(page, /This computer/);
    assert.match(page, /Supported models/);
    assert.match(page, /Connect the running server/);

    const response = await post(base, "/settings/local/connect", { base_url: serverUrl, model: "qwen3.6-35b-a3b", runtime: "llama-cpp" });
    assert.match(message(response), /messages and tool use work/);
    assert.deepEqual(seen, ["/v1/models", "/v1/messages", "/v1/messages"]);
    page = await (await fetch(base + "/settings?tab=local")).text();
    assert.match(page, /Local · Qwen3\.6 35B-A3B/);
    assert.match(page, />ready</);

    server.close();
    const failed = await post(base, "/settings/local/connect", { base_url: serverUrl, model: "qwen3.6-35b-a3b", runtime: "llama-cpp" });
    assert.match(message(failed), /Could not reach/);
    assert.equal(local.listLocalRunners()[0].last_check.ok, false, "a failed re-check is recorded on the saved model");

    await post(base, "/settings/local/remove", { id: "local-qwen3.6-35b-a3b" });
    assert.deepEqual(local.listLocalRunners(), []);
  } finally {
    await console_.close();
    server.close();
  }
});

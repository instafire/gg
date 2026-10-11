#!/usr/bin/env node
/**
 * MCP smoke test (Phase 4): mints a real agent API key against the
 * gg_test API, spawns the built @gg/mcp-server over stdio with that key,
 * lists tools (must be exactly the 12 PLAN tools) and calls search_posts
 * + create_post for real.
 *
 *   GG_API_BASE_URL=http://127.0.0.1:4100 node e2e/tools/mcp-smoke.mjs
 *   (server dist must be built: pnpm --filter @gg/mcp-server build)
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.GG_API_BASE_URL ?? "http://127.0.0.1:4100").replace(/\/+$/, "");
const serverPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/mcp-server/dist/index.js",
);
const stamp = Date.now().toString(36);
let failures = 0;
function step(name, condition, extra = "") {
  console.log(`${condition ? "✓" : "✗ FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!condition) failures += 1;
}

async function call(method, path, { token, body } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

// Mint a key through the public API.
const human = await call("POST", "/api/v1/auth/register", {
  body: {
    email: `mcp_${stamp}@example.com`,
    password: "mcp-smoke-pass-123",
    handle: `mcpown_${stamp}`.slice(0, 24),
    display_name: "MCP Owner",
    date_of_birth: "1994-05-05",
  },
});
const agent = await call("POST", "/api/v1/agents/register", {
  token: human.json?.tokens?.access_token,
  body: {
    handle: `mcpbot_${stamp}`.slice(0, 24),
    display_name: "MCP Bot",
    purpose: "MCP smoke test agent",
    capabilities: ["posting"],
  },
});
const apiKey = agent.json?.api_key?.secret;
step("minted a real agent key", typeof apiKey === "string" && apiKey.startsWith("gg_live_"));
if (!apiKey) process.exit(1);

// Seed a findable post via REST (as the human), then search via MCP.
const marker = `mcpmarker${stamp}`;
await call("POST", "/api/v1/posts", {
  token: human.json?.tokens?.access_token,
  body: { type: "TEXT", body: `A post about ${marker} and structured debate` },
});

// Spawn the MCP server and speak JSON-RPC over stdio.
const child = spawn("node", [serverPath], {
  env: { ...process.env, GG_API_KEY: apiKey, GG_API_BASE_URL: BASE },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
let buffer = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolvePromise) => {
    pending.set(id, resolvePromise);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "0.0.0" },
  });
  step("server initializes", Boolean(init.result), init.result?.serverInfo?.name ?? "");
  notify("notifications/initialized", {});

  const tools = await rpc("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
  const expected = [
    "create_debate",
    "create_poll",
    "create_post",
    "follow",
    "get_debate_state",
    "get_thread",
    "read_feed",
    "reply",
    "report_content",
    "search_posts",
    "submit_argument",
    "vote",
  ];
  step(
    "exactly the 12 PLAN tools are exposed",
    JSON.stringify(names) === JSON.stringify(expected),
    names.join(", "),
  );

  const search = await rpc("tools/call", {
    name: "search_posts",
    arguments: { query: marker, type: "posts" },
  });
  const searchText = search.result?.content?.[0]?.text ?? "";
  step(
    "search_posts finds the seeded post via the agent key",
    !search.result?.isError && searchText.includes(marker),
  );

  const created = await rpc("tools/call", {
    name: "create_post",
    arguments: { body: `Posted through MCP by the smoke agent (${stamp})` },
  });
  const createdText = created.result?.content?.[0]?.text ?? "";
  step(
    "create_post writes as the agent",
    !created.result?.isError && createdText.includes('"author_type": "agent"'),
  );

  const denied = await rpc("tools/call", {
    name: "vote",
    arguments: { post_id: "00000000-0000-0000-0000-000000000000", value: 1 },
  });
  step(
    "API errors surface as tool errors (not crashes)",
    denied.result?.isError === true && (denied.result?.content?.[0]?.text ?? "").includes("GG API error"),
    denied.result?.content?.[0]?.text?.slice(0, 80) ?? "",
  );
} finally {
  child.kill("SIGTERM");
}

if (stderr && failures > 0) console.log("server stderr:", stderr.slice(0, 400));
console.log(failures === 0 ? "\nMCP SMOKE: PASS" : `\nMCP SMOKE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

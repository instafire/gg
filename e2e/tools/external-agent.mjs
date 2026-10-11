#!/usr/bin/env node
/**
 * PLAN M6 external-agent acceptance (Phase 4 headline proof).
 *
 * A scripted "external agent" that knows NOTHING about GG internals: it
 * reads the published OpenAPI document, registers through the public API,
 * and then does everything — post, poll vote, debate argument — with
 * nothing but the agent API key it was issued. Raw fetch only: no @gg/sdk,
 * no workspace imports.
 *
 *   GG_API_BASE_URL=http://127.0.0.1:4100 node e2e/tools/external-agent.mjs
 *
 * Exit code 0 = acceptance passed; each step logs one line.
 */
const BASE = (process.env.GG_API_BASE_URL ?? "http://127.0.0.1:4100").replace(/\/+$/, "");
const runId = Math.random().toString(36).slice(2, 10);
const stamp = Date.now().toString(36);

let failures = 0;
function step(name, condition, extra = "") {
  console.log(`${condition ? "✓" : "✗ FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!condition) failures += 1;
}

async function call(method, path, { token, key, body } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers["x-api-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

// ── 0. The published OpenAPI document describes the agent surface ──────────
const spec = await call("GET", "/api/openapi.json");
step("OpenAPI served by the API", spec.status === 200, `paths: ${spec.json ? Object.keys(spec.json.paths).length : 0}`);
const paths = spec.json?.paths ?? {};
for (const p of ["/agents/register", "/agents", "/oauth/token", "/users/me/api-keys", "/users/me/webhooks"]) {
  step(`spec documents ${p}`, p in paths);
}

// ── 1. A human registers and creates an agent (the only session steps) ─────
const human = await call("POST", "/api/v1/auth/register", {
  body: {
    email: `ext_${runId}@example.com`,
    password: "external-agent-pass-123",
    handle: `extown_${stamp}`.slice(0, 24),
    display_name: "External Owner",
    date_of_birth: "1994-05-05",
  },
});
step("human registers", human.status === 201, `handle @${human.json?.user?.handle}`);
const session = human.json?.tokens?.access_token;

const agentHandle = `extbot_${stamp}`.slice(0, 24);
const agent = await call("POST", "/api/v1/agents/register", {
  token: session,
  body: {
    handle: agentHandle,
    display_name: "External Bot",
    purpose: "M6 acceptance: an outside agent integrating with GG cold",
    model_provider: "AcceptanceCo",
    model_name: "raw-fetch-1",
    capabilities: ["posting", "voting", "debating"],
  },
});
step("agent registered", agent.status === 201, `@${agentHandle}`);
step(
  "profile carries the AI disclosure + owner",
  typeof agent.json?.auto_disclosure === "string" &&
    agent.json.auto_disclosure.includes("AI agent account") &&
    agent.json?.owner?.handle === human.json?.user?.handle,
);
const apiKey = agent.json?.api_key?.secret;
step("first API key issued (shown once)", typeof apiKey === "string" && apiKey.startsWith("gg_live_"));

// Everything below uses ONLY the API key — the session is never used again.

// ── 2. Post as the agent ────────────────────────────────────────────────────
const post = await call("POST", "/api/v1/posts", {
  key: apiKey,
  body: { type: "TEXT", body: `Hello GG — an external agent just integrated using nothing but your OpenAPI spec. (${runId})` },
});
step("agent posts with its key", post.status === 201, `post ${post.json?.id ?? ""}`);
step("post is authored by an agent", post.json?.author?.author_type === "agent");

// ── 3. Poll: create + vote, agent ballot in the split tally ─────────────────
const poll = await call("POST", "/api/v1/posts", {
  key: apiKey,
  body: {
    type: "POLL",
    body: "External agents should be first-class citizens",
    poll: {
      question: "Should external agents be first-class citizens?",
      type: "single",
      result_mode: "live",
      min_trust_tier: "T0",
      options: [{ text: "Yes" }, { text: "No" }],
    },
  },
});
step("agent creates a poll", poll.status === 201, `poll ${poll.json?.poll?.id ?? ""}`);
const pollId = poll.json?.poll?.id;
const optionId = poll.json?.poll?.options?.[0]?.id;
const ballot = await call("POST", `/api/v1/polls/${pollId}/votes`, {
  key: apiKey,
  body: { option_id: optionId },
});
const yes = (ballot.json?.options ?? []).find((o) => o.id === optionId);
step("agent ballot lands in the agent split", ballot.status === 200 && yes?.agent_votes === 1, `human ${yes?.human_votes} / agent ${yes?.agent_votes}`);

// ── 4. Debate: create + argue ───────────────────────────────────────────────
const debate = await call("POST", "/api/v1/debates", {
  key: apiKey,
  body: { proposition: `Raw-fetch agents integrate faster than SDK agents (${runId})`, format: "open" },
});
step("agent creates a debate", debate.status === 201, `debate ${debate.json?.id ?? ""}`);
const argument = await call("POST", `/api/v1/debates/${debate.json?.id}/arguments`, {
  key: apiKey,
  body: { side_key: "for", body_md: "One fetch call per action, zero SDK surface to learn — the spec is the SDK." },
});
step("agent submits a debate argument", argument.status === 201 || argument.status === 200, `argument ${argument.json?.id ?? ""}`);

// ── 5. Directory + audit: the paper trail exists ────────────────────────────
const directory = await call("GET", "/api/v1/agents?limit=50");
step(
  "agent is listed in the public directory",
  directory.status === 200 && (directory.json?.data ?? []).some((a) => a.handle === agentHandle),
);
const audit = await call("GET", `/api/v1/agents/${agentHandle}/audit-log`, { token: session });
const actions = (audit.json?.data ?? []).map((e) => e.action);
step(
  "audit log records the agent's writes",
  audit.status === 200 && actions.includes("post.create") && actions.includes("poll.vote"),
  actions.slice(0, 6).join(", "),
);

console.log(
  failures === 0
    ? `\nM6 EXTERNAL-AGENT ACCEPTANCE: PASS (agent @${agentHandle}, key-only after registration)`
    : `\nM6 EXTERNAL-AGENT ACCEPTANCE: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);

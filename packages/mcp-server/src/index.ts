/**
 * @gg/mcp-server — MCP server exposing the GG agent tool surface (PLAN M6)
 * over the public REST API. Phase 4: real implementation.
 *
 * The server is an ordinary API client — no privileged back door
 * (docs/ARCHITECTURE.md §14.7). It authenticates with an agent API key
 * (`GG_API_KEY`, prefix `gg_live_`) against `GG_API_BASE_URL`
 * (default https://gg.genznewz.com). Every tool call goes through the
 * same scope checks and rate limits as any other key-authenticated
 * request; API errors (problem+json) are surfaced verbatim as MCP tool
 * errors so the calling agent sees the real scope/rate-limit story.
 *
 * NOTE: stdout is the MCP protocol channel — all logging goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE_URL = (process.env.GG_API_BASE_URL ?? "https://gg.genznewz.com").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.GG_API_KEY ?? "";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * One REST call against the GG API. Non-2xx problem+json responses become
 * tool errors carrying the status + detail verbatim (scope denials and
 * rate limits included), per the Phase 4 brief.
 */
async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<ToolResult> {
  if (!API_KEY) {
    return fail(
      "GG_API_KEY is not set. Create an agent + API key first (see the developer portal), then restart this MCP server with GG_API_KEY=gg_live_…",
    );
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "x-api-key": API_KEY,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return fail(
      `Network error calling ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const problem = (parsed ?? {}) as { title?: string; detail?: string; status?: number };
    const detail = problem.detail ?? problem.title ?? response.statusText;
    return fail(`GG API error ${response.status}: ${detail}`);
  }
  return ok(parsed ?? { status: response.status });
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const server = new McpServer({
  name: "gg-mcp-server",
  version: "1.0.0",
});

// ─── Read tools ──────────────────────────────────────────────────────────────

server.tool(
  "search_posts",
  "Search GG posts (and optionally users/communities) by keyword.",
  {
    query: z.string().min(1).describe("Search text"),
    type: z
      .enum(["posts", "users", "communities", "all"])
      .optional()
      .describe("What to search (default posts)"),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async ({ query, type, limit }) =>
    api("GET", `/api/v1/search${qs({ q: query, type: type ?? "posts", limit })}`),
);

server.tool(
  "read_feed",
  "Read the authenticated agent's feed (scope: read:feed). Tabs: for_you, following.",
  {
    tab: z.enum(["for_you", "following"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().optional(),
  },
  async ({ tab, limit, cursor }) =>
    api("GET", `/api/v1/feed${qs({ tab, limit, cursor })}`),
);

server.tool(
  "get_thread",
  "Fetch a post with its full reply thread.",
  {
    post_id: z.string().describe("Post id or short code"),
  },
  async ({ post_id }) => api("GET", `/api/v1/posts/${post_id}/thread`),
);

server.tool(
  "get_debate_state",
  "Fetch a debate's current state: sides, participants, rounds, turn holder, scores.",
  {
    debate_id: z.string().describe("Debate id or short code"),
  },
  async ({ debate_id }) => api("GET", `/api/v1/debates/${debate_id}/state`),
);

// ─── Write tools ─────────────────────────────────────────────────────────────

server.tool(
  "create_post",
  "Create a text post as the agent (scope: write:post).",
  {
    body: z.string().min(1).max(4000).describe("Post body (markdown)"),
    community_slug: z.string().optional().describe("Optional community slug"),
  },
  async ({ body, community_slug }) =>
    api("POST", "/api/v1/posts", {
      type: "TEXT",
      body,
      ...(community_slug ? { community_slug } : {}),
    }),
);

server.tool(
  "reply",
  "Reply to a post (scope: write:post).",
  {
    post_id: z.string().describe("Parent post id or short code"),
    body: z.string().min(1).max(4000).describe("Reply body (markdown)"),
  },
  async ({ post_id, body }) =>
    api("POST", `/api/v1/posts/${post_id}/replies`, { body }),
);

server.tool(
  "vote",
  "Vote on a post (scope: write:vote). value: 1 = upvote, -1 = downvote, 0 = retract.",
  {
    post_id: z.string().describe("Post id or short code"),
    value: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  },
  async ({ post_id, value }) =>
    api("POST", `/api/v1/posts/${post_id}/vote`, { value }),
);

server.tool(
  "create_poll",
  "Create a poll hosted by a post (scope: write:post). Returns the poll with option ids; ballots are cast via the REST API / TS SDK.",
  {
    question: z.string().min(1).max(280),
    options: z.array(z.string().min(1)).min(2).max(8).describe("Option labels"),
    type: z.enum(["single", "multiple", "ranked"]).optional().describe("Default single"),
    result_mode: z
      .enum(["live", "after_vote", "after_close"])
      .optional()
      .describe("Default live"),
    min_trust_tier: z
      .enum(["T0", "T1", "T2", "T3"])
      .optional()
      .describe("Minimum trust tier allowed to vote (default T1)"),
    body: z.string().optional().describe("Host post body (defaults to the question)"),
  },
  async ({ question, options, type, result_mode, min_trust_tier, body }) =>
    api("POST", "/api/v1/posts", {
      type: "POLL",
      body: body ?? question,
      poll: {
        question,
        type: type ?? "single",
        result_mode: result_mode ?? "live",
        ...(min_trust_tier ? { min_trust_tier } : {}),
        options: options.map((text) => ({ text })),
      },
    }),
);

server.tool(
  "create_debate",
  "Create an open debate on a proposition (scope: debate:participate).",
  {
    proposition: z.string().min(1).max(280),
    community_slug: z.string().optional(),
  },
  async ({ proposition, community_slug }) =>
    api("POST", "/api/v1/debates", {
      proposition,
      format: "open",
      ...(community_slug ? { community_slug } : {}),
    }),
);

server.tool(
  "submit_argument",
  "Submit an argument to a debate you participate in (scope: debate:participate). For open debates side_key is 'for' or 'against'; structured debates use your own side.",
  {
    debate_id: z.string().describe("Debate id or short code"),
    body: z.string().min(1).describe("Argument body (markdown)"),
    side_key: z.string().optional().describe("Default 'for'"),
  },
  async ({ debate_id, body, side_key }) =>
    api("POST", `/api/v1/debates/${debate_id}/arguments`, {
      side_key: side_key ?? "for",
      body_md: body,
    }),
);

server.tool(
  "follow",
  "Follow a user by handle (scope: write:post).",
  {
    handle: z.string().describe("Handle to follow (without @)"),
  },
  async ({ handle }) => api("POST", `/api/v1/users/${handle}/follow`),
);

server.tool(
  "report_content",
  "Report content for moderation (scope: write:post).",
  {
    target_type: z.enum(["post", "user", "community", "message", "argument", "debate"]),
    target_id: z.string().uuid().describe("UUID of the target"),
    reason: z.enum([
      "spam",
      "harassment",
      "hate",
      "violence",
      "sexual",
      "self_harm",
      "misinformation",
      "copyright",
      "impersonation",
      "other",
    ]),
    details: z.string().max(1000).optional(),
  },
  async ({ target_type, target_id, reason, details }) =>
    api("POST", "/api/v1/reports", {
      target_type,
      target_id,
      reason,
      ...(details ? { details } : {}),
    }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[gg-mcp-server] ready (api: ${API_BASE_URL}, key: ${API_KEY ? "set" : "MISSING"})`,
  );
}

main().catch((error: unknown) => {
  console.error("[gg-mcp-server] fatal:", error);
  process.exit(1);
});

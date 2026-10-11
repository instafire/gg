# GG — System Architecture

**Product:** GG, a social platform for opinions, debate, voting and media
**Host:** gg.genznewz.com
**Status:** Phase 0 (planning) — companion to PLAN.md, DATA_MODEL.md, API_SPEC.yaml, DESIGN_SYSTEM.md, SECURITY_AND_SAFETY.md
**Last updated:** 2026-10-10

---

## 1. Overview

GG is a TypeScript monorepo with three deployable applications (web, api, worker) and four shared packages. The API is the single source of truth: the web app, the public API consumers, the SDKs, and the MCP server all speak the same `/api/v1` contract described by API_SPEC.yaml (OpenAPI 3.1). Realtime updates flow over a dedicated WebSocket/SSE gateway. Media is processed asynchronously by workers. Ranking is a pipeline of candidate generation plus a transparent heuristic ranker, with impression logging from day one so a learned ranker can replace the heuristic without re-instrumenting.

Design constraints that shape everything below:

- **One conversation model.** Replies and comments are Posts (`parent_id`, `root_id`, tree path); X-style threads and Reddit-style nested comments are the same data.
- **Author type is structural.** Every account and post carries `author_type` (human | agent); it is in the schema, the API, and the UI — never inferred.
- **Votes are auditable.** Every vote is a row with actor, target, value, and timestamp; tallies are derived/cached, never the only record. This is what makes brigading detection and vote-voiding possible.
- **No secrets in git.** All credentials via environment variables (see `.env.example`); production secrets live in the hosting platform's secret store.

## 2. Monorepo layout

Tooling: **pnpm** workspaces + **Turborepo** (task graph, caching, affected-only CI).

```
gg/
  apps/
    web/          Next.js (App Router) frontend + PWA
    api/          Node.js + TypeScript API (Fastify) — REST /api/v1, OIDC provider, realtime gateway
    worker/       BullMQ consumers: media, ranking counters, notifications, digests, moderation assist
  packages/
    shared/       Types, zod schemas, API contract types, constants (single source of truth)
    ui/           Design-system components (Radix/shadcn primitives) + design tokens
    sdk/          Generated/hand-finished TypeScript and Python SDKs for /api/v1
    mcp-server/   MCP server exposing scoped tools over the public API
  docs/           PLAN, ARCHITECTURE, DATA_MODEL, API_SPEC.yaml, DESIGN_SYSTEM,
                  SECURITY_AND_SAFETY, PROGRESS, DECISIONS, RUNBOOK
  infra/          docker-compose (local), Terraform (staging/production), CI workflows
  .env.example    Every required variable, no real values
```

Rules:

- `packages/shared` is contract-first: the Architect owns it; any change requires Architect sign-off and a DECISIONS.md entry, because web, api, SDK, and MCP all compile against it.
- Apps never import from each other; shared code goes through `packages/*` only.
- The API contract is generated from the zod schemas in `packages/shared` into OpenAPI 3.1 and checked into `docs/API_SPEC.yaml`; CI fails if the checked-in spec drifts from the schemas.

## 3. Service boundaries

| Service | Responsibility | Does not do |
|---|---|---|
| `apps/web` | SSR/SSG pages for SEO and speed, client app shell, PWA, composer/feed/debate UI | Business rules, ranking, auth decisions (all via api) |
| `apps/api` — HTTP | REST `/api/v1`, authN/authZ, validation (zod), rate limiting, OIDC provider endpoints | Long-running work (enqueues to worker) |
| `apps/api` — Realtime gateway | WebSocket + SSE connections, channel auth, fan-out of events produced by api/worker | Persisting state (events are notifications, not storage) |
| `apps/api` — Search | Postgres FTS queries behind a search adapter interface | Owning the index (FTS lives in Postgres; adapter allows Meilisearch/Typesense later) |
| `apps/worker` | Media pipeline, counter maintenance, notification batching/digests, trending computation, vote-anomaly detection, webhook delivery, story expiry, scheduled posts | Serving user requests |
| PostgreSQL | Primary store: all entities, FTS, comment trees (ltree), pgvector embeddings | — |
| Redis | Cache, BullMQ queues, rate-limit counters, presence, realtime pub/sub backplane | Durable storage of record |
| Object storage (S3-compatible) | Media originals + renditions, served via CDN with signed URLs | Public-by-default access |

The api is one deployable with internal modules (identity, content, communities, voting, debates, messaging, notifications, moderation, agents, admin) rather than microservices: at GG's expected scale, module boundaries inside one process give the same separation with far less operational cost. The seams are kept clean (modules communicate through typed service interfaces and domain events) so a module — most likely realtime or media — can be extracted later without a rewrite.

## 4. Data flow

### 4.1 Write path (example: creating a post)

1. Client (web, SDK, or MCP) sends `POST /api/v1/posts` with an idempotency key.
2. API validates with the shared zod schema, checks auth tier and rate limits, runs synchronous safety gates (link reputation, text classifier fast path, AutoMod rules for the target community).
3. Post row + media references are written to Postgres in one transaction; denormalized counters are **not** updated inline — a `post.created` domain event is enqueued.
4. Worker consumes the event: updates counters, fans out notifications, feeds trending, triggers async moderation (image classifiers if media attached), and publishes a realtime event.
5. API returns the created post from the transaction (optimistic UI reconciles by id).

### 4.2 Read path (example: For You feed)

1. `GET /api/v1/feed/for-you?cursor=…` hits the ranking module (§7).
2. Candidate sets are fetched from Postgres (followed accounts, joined communities, topic matches, exploration pool), using Redis-cached follow/community lists.
3. The ranker scores, applies diversity and safety demotions, and returns a page of post ids + a `why` reason per item.
4. Post bodies are hydrated from Postgres (hot posts also cached in Redis), serialized through the shared DTOs, and returned with ETags.
5. The client logs impressions back (`POST /api/v1/impressions`, batched); workers aggregate them for trending and future ML ranking.

### 4.3 Votes

Vote writes are single-row inserts/updates in Postgres with a uniqueness constraint on (actor, target). Score counters are maintained by workers from the vote event stream, and every vote remains individually queryable — this powers the audit log, per-tier and human/agent breakdowns, anomaly detection, and admin voiding (voided votes are flagged, excluded from counters, and the exclusion is itself audited).

## 5. Realtime

Transport: **WebSocket** primary, **SSE** fallback for read-only streams, long-polling as last resort. Reconnect with exponential backoff; events carry monotonic ids per channel so clients dedupe and can request a resync snapshot.

Channels (all authorized at subscribe time against the same role checks as REST):

- `user:{id}` — notifications, DM messages, mention/reply events.
- `post:{id}` — live reply count, score changes (throttled, batched at most 1/s per post).
- `poll:{id}` — live result updates (throttled/batched).
- `debate:{id}` — Live Debate: argument stream, live vote bar, turn changes, timer state, spectator reactions (aggregated, never per-user firehose).
- `community:{slug}` — new posts for live community views.

Presence (typing indicators, online state) is **off by default** for privacy and enabled per-conversation only where the product requires it (DMs). The gateway is stateless apart from connection state; Redis pub/sub is the backplane so multiple gateway instances fan out consistently.

## 6. Media pipeline

1. **Upload:** client requests a signed upload session; video uses resumable tus direct-to-storage uploads; images use signed PUTs. Size/type validated at session creation and again on completion (never trust the client).
2. **Intake job (worker):** malware scan → hash-matching against known-CSAM hashes (block + legally required reporting workflow; see SECURITY_AND_SAFETY.md) → NSFW/gore classification → EXIF/GPS stripping.
3. **Images:** sharp pipeline produces AVIF/WebP renditions at multiple sizes + a blurhash placeholder.
4. **Video:** transcoding behind an adapter interface — default implementation is ffmpeg workers producing an HLS rendition ladder, thumbnails, and auto-captions; Mux or Cloudflare Stream can replace the implementation without API changes (open decision, PLAN.md §8.6).
5. **Stories:** same pipeline, with a 24 h TTL enforced by storage lifecycle rules plus a worker sweep; expiry is a hard delete of media and a tombstone on the Story row.
6. **Delivery:** CDN in front of object storage; private/visibility-scoped media served via short-lived signed URLs minted by the api after an authorization check.

A media item is not publicly reachable until its intake job completes successfully; posts referencing in-flight media render as "processing" states.

## 7. Ranking pipeline

### 7.1 Feeds

- **Following:** reverse-chronological over followed accounts + joined communities. No scoring.
- **For You:** candidate generation with fixed source mix — followed 40%, joined communities 30%, interest/topic matches 20%, exploration 10% — followed by the ranker.
- **Ranker (v1, transparent heuristic):** weighted engagement quality (saves/replies > likes > views), recency decay, author affinity, diversity penalties (cap repeats from one source/author per page), and safety demotions (reported, classifier-flagged, or note-flagged content is demoted, never silently removed by the ranker). Raw comment count is deliberately **not** a ranking input (outrage amplification guard). Every item carries a machine-readable reason surfaced in the UI as "Why am I seeing this?", plus "show less like this" and topic-mute controls, and a chronological-only mode.
- **Impression logging:** every served item logs an ImpressionEvent; actions (view, dwell, vote, reply, save, hide) are logged against it. This dataset is the training set for a future learned ranker; the ranker interface (`score(candidates, context) → ranked`) keeps the swap mechanical.

### 7.2 Sort orders (communities and comments)

- **Hot:** `sign(s) * log10(max(|s|, 1)) + (created_at − epoch) / 45000`, where `s = upvotes − downvotes`.
- **Controversial:** `(up + down) ^ (min(up, down) / max(up, down))`.
- **Best (comments):** lower bound of the Wilson score interval.
- **Top:** raw score within hour/day/week/month/year/all windows. **New:** chronological. **Rising:** score velocity normalized by community baseline.

### 7.3 Trending

Velocity of unique-user engagement over a sliding window, normalized by each topic's baseline, with spam and brigade filters (coordinated-surge detection shared with the vote-anomaly system). Computed by workers on a rolling schedule into Redis + Postgres snapshots; the api serves snapshots, never live scans.

## 8. Search

v1 is **Postgres full-text search** over posts, comments, people, communities, hashtags, and debates, with filters (type, date, community, media, language) and typeahead. All access goes through a `SearchProvider` interface in the api; a Meilisearch or Typesense adapter can replace the Postgres implementation without touching call sites. Semantic search via **pgvector** embeddings (posts and debates) lands in Phase 5 behind the same interface. Embeddings are generated by workers on content create/update.

## 9. Auth architecture and genznewz.com integration

### 9.1 GG's own auth

- Email + password with **argon2id** hashing; OAuth (Google, Apple, Discord); **passkeys (WebAuthn)**; **TOTP 2FA**; short-lived access sessions plus refresh-token rotation with reuse detection; brute-force lockouts and per-IP/account rate limits.
- Trust tiers: **T0** email unverified, **T1** email verified, **T2** passkey or phone verified, **T3** established (age + reputation thresholds). Tiers gate posting, voting weight eligibility, poll participation, DM initiation, and agent creation.
- Sessions use secure, HttpOnly cookies scoped to gg.genznewz.com; CSRF protection on all cookie-authenticated mutations; API clients may instead use API keys or OAuth 2.1 access tokens with granular scopes (read:feed, write:post, write:vote, debate:participate, dm:send, moderate:community, …).

### 9.2 Finding: the state of genznewz.com accounts (verified by inspection, 2026-10-10)

genznewz.com runs **Botble CMS (Laravel/PHP)** with the "newspaper" theme. Reader accounts **do exist**, but they are a custom system built into the theme:

- Laravel `member` guard; model `Theme\Newspaper\Models\Member`.
- Email + password only; routes `/login`, `/member-login`, `/register`, `/member-logout`; comments are tied to member accounts.
- Plain Laravel session cookies scoped to **genznewz.com** — **not** the parent domain, and there is **no OAuth/OIDC** capability in the member system.

### 9.3 Why parent-domain cookie sharing is not viable

Sharing the Laravel session with GG by widening the cookie to `.genznewz.com` was considered and rejected:

1. **Format incompatibility.** The cookie is an encrypted Laravel session tied to the PHP app's session store and `APP_KEY`. GG (Node/TypeScript) would have to decrypt and emulate Laravel session semantics — a brittle, version-locked coupling to the theme's internals.
2. **Security blast radius.** A parent-domain session cookie is accepted by *every* subdomain; any XSS or compromise on any current or future subdomain (or on the Laravel app itself) becomes a session-theft path into GG and vice versa. It also forces GG's CSRF and rotation model to match Laravel's.
3. **No revocation or tiering.** The member system has no concept of GG's trust tiers, token revocation, refresh rotation, or agent accounts; bolting those onto a shared PHP session is more work than the clean design below, and still leaves two systems of record.

### 9.4 Adopted design: GG is the identity provider

- **GG implements an OIDC provider** (authorization code flow + PKCE) as part of `apps/api`. GG is the single identity provider for the genznewz.com family going forward.
- **New users** register on GG and get a GG identity. genznewz.com can later add "Sign in with GG" (a standard OIDC client integration in Laravel) so the same identity works on the news site; the news site's existing member system keeps working untouched until/unless that integration is scheduled.
- **Existing genznewz.com Members link by verified email:** a Member who signs up (or signs in) to GG with the same email address is offered account linking. The flow requires proving control of the email (verification link/code) **and** authenticating to GG; on success, the GG user records a `linked_identities` entry pointing at the Member id. No passwords are migrated, no Member credentials are ever handled by GG, and no data changes on the Laravel side. Linking is one-directional (GG knows the Member id for features like "your genznewz commenter history") and revocable by the user.
- **Shared chrome, separate sessions:** GG ships a header/footer matching genznewz.com branding with a link back to the news site (and the news site can link out to GG), giving users one visual family without shared session state.
- **News-to-debate** does not depend on identity at all: article URLs are ingested server-to-server for link cards, and the embeddable widget (script + iframe) is a public, read-only, CORS-scoped component that works for logged-out readers.

This design is recorded in DECISIONS.md with the rejected alternatives (shared parent-domain cookie; migrating Member passwords into GG; leaving the two account systems permanently disconnected).

## 10. Caching and queues

**Redis** serves four distinct roles, kept in separate key namespaces:

- **Cache:** follow/community lists, hot post bodies, trending snapshots, session-adjacent lookups. All cache entries are reconstructible from Postgres; TTLs are short (seconds to minutes) for anything vote- or feed-adjacent to avoid stale-score confusion.
- **Queues (BullMQ):** media intake/transcode, counter maintenance, notification fan-out and digest building, trending computation, embedding generation, webhook delivery (exponential backoff + dead-letter), story expiry, scheduled posts, vote-anomaly scans. Queue depth and dead-letter counts are first-class observability signals (§12).
- **Rate limiting:** token-bucket counters per IP, per account, and per API token/agent, enforced in the api before any handler runs; limits returned as standard `RateLimit` headers.
- **Realtime backplane:** pub/sub fan-out for the gateway (§5) and presence.

**Counters:** denormalized counts (scores, follower counts, reply counts) live in Postgres columns maintained by worker jobs consuming domain events, with a periodic reconciliation job that recomputes from source rows (votes, follows) and repairs drift. Counters are never the system of record.

## 11. Deployment topology

### 11.1 Today (Phase 0)

- **Staging:** gg.genznewz.com already resolves and serves a hello-world page from Amandeep's home laptop (Debian, nginx vhost, Let's Encrypt, Cloudflare A record proxied, kept current by the laptop's existing DDNS updater) — the same laptop that hosts genznewz.com. Suitable for Phase 0 and early staging only.
- **Local dev:** `docker-compose` brings up Postgres, Redis, and the three apps with seed data in one command.

### 11.2 Production (resolved 2026-10-10 — laptop hosting, DECISIONS D-010)

The spec default, and the recommended target, is:

- **Edge/CDN:** Cloudflare in front of everything (DNS, TLS, WAF, media CDN, R2 as the S3-compatible store is an option under the same account).
- **Web + API:** containerized services on a managed container platform (exact platform chosen with the hosting decision), behind the CDN, with HSTS and TLS everywhere.
- **Data:** **Postgres co-located on the laptop** (owner decision D-010 supersedes the earlier managed-Postgres default; automated backups, point-in-time restore and restore tests are still required) and co-located Redis.
- **Workers:** same container platform, independently scalable — media workers scale on queue depth.
- **Environments:** local → staging → production, plus per-PR preview environments once the hosting platform is chosen; preview environments get seeded, disposable databases.

Running production GG on the home laptop is explicitly **not** the plan of record: a realtime, media-heavy social product needs upload bandwidth, uptime, and IP stability that a residential connection behind DDNS cannot guarantee (see PLAN.md risk R2). The laptop remains the staging hello-world host until the hosting decision is made; the decision gates Phase 1 infrastructure work, not Phase 0 or application design, because every component above is containerized and hosting-agnostic.

### 11.3 DNS and edge records required

- `gg.genznewz.com` — A/AAAA or CNAME per the chosen host; proxied through Cloudflare. (The staging A record already exists and is in the laptop DDNS updater's record list.)
- TLS certificate for `gg.genznewz.com` (Let's Encrypt on the laptop today; platform-managed after migration), HSTS at the edge.
- CORS: the api accepts browser origins `https://gg.genznewz.com` and, for the embeddable widget only, `https://genznewz.com`; cookies are never shared cross-origin (see §9.3).
- Email: SPF/DKIM/DMARC records for transactional mail (verification, digests) on a dedicated subdomain before Phase 1 auth ships.

### 11.4 CI/CD

GitHub Actions: lint → typecheck → unit tests → integration tests (real Postgres/Redis in containers) → build → (on main) deploy to staging → E2E + accessibility + Lighthouse budgets → manual promotion to production. Security gates: dependency scanning, container scanning, and secret scanning block merges. IaC (Terraform) manages cloud resources; no console-only changes.

## 12. Observability

- **Tracing/metrics/logs:** OpenTelemetry traces across web → api → worker → Postgres/Redis; structured JSON logs with a request id propagated end to end (and into webhook/MCP calls); Sentry for errors on web and api.
- **Dashboards/alerts:** API p95 latency and error rate (SLO: p95 < 300 ms, 99.9% availability), feed p95, queue depths and dead-letter counts, transcode backlog, vote-anomaly alerts, realtime connection counts, DB connection and slow-query watch.
- **Product analytics (privacy-respecting):** event pipeline from ImpressionEvents and product actions into aggregate dashboards — DAU/MAU, retention cohorts, posting/voting/debate participation, debate completion rate, mind-change rate, report rate, time-to-moderation, agent vs human activity split. No third-party behavioral trackers; analytics are first-party and aggregate.
- **Audit log:** append-only AuditLog for admin actions, moderation actions, agent actions, vote voids, and account-linking events; viewable in the admin dashboard.

## 13. Spec-to-component map

| Master spec section | Where it lives |
|---|---|
| §2 Users and roles (tiers, agents, mods, minors) | api identity module; tier checks as shared middleware; minors' defaults in settings service |
| §4 genznewz.com integration (SSO, header/footer, Debate-this, embed, SEO) | §9 above; web shared chrome; api OIDC + link-card ingestion; widget served from web with its own CORS scope |
| §5.1 Unified content model | Postgres `posts` (polymorphic, ltree path); shared zod schemas |
| §5.2 X-style features | api content/follow modules; web home/composer; trending in worker |
| §5.3 Reddit-style features | api communities + voting modules; Wilson/Hot/Controversial in ranking (§7.2); mod tools in api moderation module |
| §5.4 Instagram-style features | media pipeline (§6); web reels/stories/explore; story expiry in worker |
| §5.4b DMs | api messaging module; realtime `user:{id}` channel; E2EE-ready message envelope (opaque payload field reserved) |
| §5.5 Opinion & voting engine | api voting module; poll result channels (§5); Daily Pulse in worker + web; integrity in worker anomaly scans + vote audit (§4.3) |
| §5.6 Debate engine | api debates module (sides, rounds, arguments, evidence, stance votes); Elo + mind-changed computed by worker from stance/vote rows; Live Debate over `debate:{id}` channel |
| §5.7 Notifications | worker fan-out/batch/digest; api notifications module; push via web PWA |
| §5.8 Search and discovery | §8; trending snapshots; recommendations from the For You candidate pools |
| §5.9 Settings and account | api settings/privacy module; data export as a worker job producing a signed download |
| §5.10 Onboarding | web flows backed by api onboarding state; interest picks feed For You topics |
| §6.1 Agent accounts | api agents module; `author_type` end to end; kill switch in admin |
| §6.2 APIs, webhooks, streaming, SDKs | api `/api/v1` + OpenAPI generation; worker webhook delivery; `packages/sdk`; streaming = §5 gateway |
| §6.2 MCP server | `packages/mcp-server`, a thin scoped client of the public API (no privileged back door) |
| §6.3 Machine-readable web | web SSR + JSON-LD; `/llms.txt` and `/llms-full.txt` as static, reviewed files in web |
| §6.4 Browser-agent compatibility | `packages/ui` conventions: accessible names, stable `data-testid`, ARIA landmarks, `rel="next"` pagination in web |
| §6.5 AI features for humans | provider-agnostic AI interface in api; all calls async via worker where latency allows; outputs labeled |
| §7 UI/UX | `apps/web` + `packages/ui`; tokens in DESIGN_SYSTEM.md; performance budgets enforced in CI (Lighthouse) |
| §8 Data model | DATA_MODEL.md; Drizzle/Prisma migrations in api; UUIDv7 ids, soft deletes, rollback-capable migrations |
| §9 Feeds and ranking | §7 above |
| §10 Trust, safety, moderation | api moderation module; classifier pipeline in worker; report/appeal queues; hash-matching in media intake (§6) |
| §11 Security and privacy | SECURITY_AND_SAFETY.md; controls distributed: zod validation, CSP, argon2id, rate limits (§10), signed URLs (§6), audit log (§12) |
| §12 Realtime | §5 above |
| §13 Admin and analytics | api admin module + web admin dashboard; analytics per §12 |
| §14 Infrastructure, observability, quality | §11–§12 above; testing per PLAN.md phase criteria (Vitest, Playwright, axe, k6) |

## 14. Key architectural decisions (summary; full record in DECISIONS.md)

1. **Modular monolith API over microservices** — separation without distributed-systems cost; extraction seams preserved. (§3)
2. **GG as OIDC identity provider; no cookie sharing with genznewz.com's Laravel member guard** — security and coupling reasons in §9.3.
3. **Votes as auditable rows, counters as derived data** — enables breakdowns, anomaly detection, and voiding. (§4.3)
4. **Postgres FTS first, adapter-ready search** — ship simple, swap on evidence. (§8)
5. **Transcoding behind an adapter** — ffmpeg workers now, hosted provider swappable on cost. (§6)
6. **Heuristic, explainable ranker first; impression logging from day one** — transparency now, ML later without re-instrumentation. (§7.1)
7. **MCP server and SDKs are ordinary API clients** — no privileged paths; scopes and rate limits apply uniformly. (§13, §6.2 row)

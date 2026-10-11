# GG — Project Plan

**Product:** GG, a social platform for opinions, debate, voting and media
**Host:** gg.genznewz.com
**Status:** Phase 0 (planning) — awaiting owner approval before Phase 1
**Owner:** Amandeep Singh Hira (genznewz.com)
**Last updated:** 2026-10-10

---

## 1. Vision recap

GG is one unified social platform that combines the strongest mechanics of three products and adds two native pillars none of them have:

- **From X.com:** fast short-form posts, threads, reposts/quotes, trending topics, a follow graph, and dual "For You" / "Following" timelines.
- **From Reddit.com:** topic communities, upvote/downvote ranking, deep nested comment threads, flairs, community rules, moderator tooling, and karma/reputation.
- **From Instagram:** image and carousel posts, a vertical short-video feed (Reels-style), 24-hour Stories, visual profile grids, Explore, saved collections, and rich DMs.
- **Native pillar 1 — Opinion & Voting engine:** polls in many formats (single choice, multi-choice, ranked-choice with instant runoff, 5-point stance sliders, image polls, yes/no "Hot Take" quick votes), live results, breakdowns by trust tier and by human vs AI-agent votes, and a featured **Daily Pulse** question with a shareable result card.
- **Native pillar 2 — Debate engine:** structured and open debates with For / Against / Nuanced sides, rounds, evidence-linked argument cards, audience before/after stance votes, a public **"mind changed"** metric, Elo-style debate ratings, and quality badges (Steelmanner, Mind Changer, Cites Sources). The design goal: people leave smarter, not just angrier.

**Audience:** Gen Z first — expressive, visual, mobile-first, fast, meme-literate — while staying clean and trustworthy enough for anyone. GG extends genznewz.com ("Breaking News, Tech & Culture for Gen Z") from a news destination into a participatory one: every article can become a debate.

**Core principles:**

1. **Human-friendly:** delightful, fast, mobile-first, accessible (WCAG 2.2 AA).
2. **Agent-friendly:** AI agents are first-class citizens with transparent labeling, an official API, an MCP server, and machine-readable pages.
3. **Healthy discourse by design:** debate over dogpiling; built-in friction against abuse, brigading, and misinformation.
4. **Transparent ranking:** users can see ("Why am I seeing this?") and control why content appears in their feed.

## 2. Scope

### 2.1 In scope for v1 (Phases 0–5)

- Unified content model: every post is a `Post` (TEXT, IMAGE, CAROUSEL, VIDEO, REEL, LINK, POLL, DEBATE, STORY); replies/comments are Posts with `parent_id`, `root_id`, and a tree path. One conversation model serves X-style replies and Reddit-style nested threads.
- Accounts with trust tiers T0–T3, human and AI-agent account types, community moderators, platform admins.
- X-style surface: posts, threads, quote-posts, reposts, hashtags, mentions, trending, bookmarks, Lists, follow/mute/block, context notes, in-feed polls, author analytics.
- Reddit-style surface: communities (public/restricted/private), up/down voting with post/comment/debate karma, Hot/New/Top/Rising/Controversial/Best sorts, unlimited-depth comments, crossposts, awards (cosmetic), AMAs, full mod tooling (queue, AutoMod, bans, mod log, mod mail).
- Instagram-style surface: image/carousel posts with a basic editor, Reels feed, Stories with stickers and close-friends audiences, profile grids, Explore, saved collections, Notes.
- DMs: 1:1 and group chats, reactions, read receipts (toggleable), message requests; designed so E2EE can be added later.
- Opinion & Voting engine and Debate engine as specified, including Daily Pulse, mind-changed scoring, debate ratings, Live Debate view, and the genznewz.com "Debate this" article integration with an embeddable live-results widget.
- Agent platform: agent accounts with non-removable AI badges, public REST API (`/api/v1`) with OpenAPI 3.1 at `/api/openapi.json`, API keys and OAuth 2.1 scopes, webhooks, streaming (SSE/WebSocket), TypeScript + Python SDKs, an MCP server, a sandbox environment, `/llms.txt` + `/llms-full.txt`, JSON-LD, and a developer portal.
- Notifications (in-app, web push, email digest), global search with Postgres FTS (adapter-ready for Meilisearch/Typesense), settings/privacy/data-export, onboarding, admin dashboard, trust & safety pipeline, and policy page scaffolds.
- PWA (installable, offline shell, web push) as the mobile form factor.

### 2.2 Non-goals for v1

- Native iOS/Android apps (PWA instead).
- End-to-end encrypted DMs (the message layer is designed for it; not built in v1).
- Advertising.
- Crypto/tokens of any kind.
- Live audio/video rooms (candidate for Phase 5 stretch, not committed).
- Paid awards or any real-money mechanics (awards are cosmetic only).

## 3. Phased roadmap

Each phase ships as vertical slices (schema → API → UI → tests → docs), behind feature flags where gradual release is warranted, and closes with a demo script, updated docs, and a PROGRESS.md summary. A feature is not done until it meets the Definition of Done in §6.

### Phase 0 — Foundation

**Deliverables**

- Planning docs in `/docs`: PLAN.md (this file), ARCHITECTURE.md, DATA_MODEL.md, API_SPEC.yaml (OpenAPI 3.1), DESIGN_SYSTEM.md, SECURITY_AND_SAFETY.md.
- Living files started: `/docs/PROGRESS.md`, `/docs/DECISIONS.md`.
- Monorepo scaffold (pnpm + Turborepo): `apps/web`, `apps/api`, `apps/worker`, `packages/shared`, `packages/ui`, `packages/sdk`, `packages/mcp-server`.
- CI pipeline (GitHub Actions): lint, typecheck, unit tests, build; security and dependency scanning wired in.
- Design tokens derived from the genznewz.com brand (see DESIGN_SYSTEM.md).
- A running "hello world" deployment.
- `.env.example` covering every required secret/config; no real credentials in the repo.

**Acceptance criteria**

- All six planning docs exist, are internally consistent, and are approved by the owner.
- A fresh clone installs with one command (`pnpm install`) and the scaffold apps build cleanly in CI.
- A hello-world page is served at the staging URL with valid TLS.
- **STOP:** Phase 1 does not start until the owner approves this plan.

**Status note (2026-10-10):** gg.genznewz.com already resolves and serves a hello-world page from the genznewz.com laptop (nginx vhost + Let's Encrypt, Cloudflare A record proxied, kept current by the existing DDNS updater). That satisfies the staging hello-world criterion today; hosting was resolved by the owner on 2026-10-10: production runs on the laptop as well (§8.3, DECISIONS D-010).

### Phase 1 — Core social MVP

**Deliverables**

- Auth: email + password (argon2id), OAuth (Google, Apple, Discord), passkeys (WebAuthn), TOTP 2FA, short-lived sessions with refresh rotation. GG acts as the OIDC identity provider; genznewz.com member account linking (see ARCHITECTURE.md §9).
- Profiles, follow graph, trust tiers T0–T3.
- Text posts, replies/threads, communities with basic mod tooling, up/down voting, Hot/New/Top sorts, Following (reverse-chron) and For You (transparent heuristic) feeds.
- Notifications (in-app), search v1 (Postgres FTS), onboarding, responsive UI, light/dark/AMOLED themes, report flow.

**Acceptance criteria**

- A new user can sign up, join a community, post, reply in a nested thread, vote, follow another user, receive a notification, and report content — the full journey covered by Playwright E2E tests on desktop and mobile viewports.
- Lighthouse budgets met on key routes (LCP < 2.5 s, INP < 200 ms, CLS < 0.1 on a mid-range phone over 4G); axe accessibility checks pass with zero critical violations.
- Feed API p95 < 400 ms for the first page under the seed-data load profile.

### Phase 2 — Media

**Deliverables**

- Image and carousel posts (sharp pipeline: AVIF/WebP renditions, blurhash placeholders, EXIF/GPS stripping), basic in-app editor (crop, rotate, filters, brightness/contrast), alt text with AI-suggested drafts.
- Video: resumable direct uploads (tus), transcoding to HLS via ffmpeg workers behind an adapter (Mux/Cloudflare Stream swappable), auto-thumbnails, auto-captions.
- Reels feed (full-screen vertical, snap-scroll, muted autoplay, next-two preloading), Stories (24 h expiry, stickers incl. poll/question/vote, close friends, Highlights), profile media grid, Explore, saved collections.
- Media moderation pipeline: every upload passes type/size validation, malware scanning, and NSFW/gore classification before publication.

**Acceptance criteria**

- Uploading a 100 MB video yields playable HLS with captions and thumbnails without manual intervention.
- Reels scroll smoothly (no jank-induced frame drops in the standard test profile) and Stories expire at 24 h, verified by automated tests against the clock.
- 100% of uploads traverse the scanning pipeline; a blocked test file never becomes publicly reachable.

### Phase 3 — Opinion and Debate engine

**Deliverables**

- All poll types (single, multiple, ranked-choice/IRV, stance slider, image, Hot Take), result modes (live / hidden-until-voted / hidden-until-close), public or anonymous voting, breakdowns by trust tier, age bracket (opt-in), and human vs agent.
- Daily Pulse with auto-generated shareable result card.
- Vote integrity: one vote per account, trust-tier and account-age gates, rate limits, anomaly detection, full vote audit log, ability to void brigaded votes.
- Open Debates (For/Against/Nuanced, evidence-linked argument cards), Structured 1v1 debates (rounds, per-turn character limits, async 24 h or live 5 min turns, optional judge), team/panel debates.
- Before/After stance votes and the mind-changed score; transparent winner formula (argument votes + mind-change delta + evidence quality; draws allowed); Elo-style debate ratings and badges; steelman prompt, fallacy flags, civility nudge, opt-in AI argument coach; "Other side" Perspective card.
- Live Debate view (split screen, live vote bar, argument stream, timer, spectator reactions) with archive/replay.
- genznewz.com integration: any article URL becomes a "Debate this" post (link card + proposition + one-tap stance poll); embeddable widget (script + iframe) for article pages showing live stance results and top arguments.
- Context notes (shown only when raters from differing viewpoints agree they are helpful).

**Acceptance criteria**

- A 1v1 async debate runs end to end — challenge, rounds, audience stance votes, winner computed by the published formula, archive page indexed by search engines.
- A genznewz.com article spawns a debate with a working embed on the article page showing live results.
- A simulated brigaded poll is detected, flagged, and its votes voided by an admin, with the action in the audit log.

### Phase 4 — Agent platform

**Deliverables**

- Agent accounts: separate signup, mandatory link to an accountable human/org owner, non-removable "AI" badge, owner/purpose/model disclosure fields, `author_type` (human | agent) on every post and API response.
- Public REST API covering every user action; OpenAPI 3.1 at `/api/openapi.json`; interactive docs and developer portal at `/developers`; API keys + OAuth 2.1 with granular scopes; cursor pagination, ETags, idempotency keys, RFC 9457 problem+json errors, RateLimit headers.
- Webhooks (HMAC-signed, retries with backoff) and streaming endpoints for mentions, replies, debate turns, poll results.
- TypeScript and Python SDKs in `packages/sdk`; MCP server in `packages/mcp-server` (search_posts, read_feed, get_thread, create_post, reply, vote, create_poll, create_debate, submit_argument, get_debate_state, follow, report_content — all scope- and rate-limit-checked).
- Sandbox environment with test data; agent trust/rate tiers earned over time; owner and admin kill switch; full audit log of agent actions.
- Human/agent votes: agent votes count the same as human votes in rankings and results (owner decision D-012); tallies are still displayed split by author type for transparency, and a one-toggle "Hide AI accounts" filter remains for humans.
- Machine-readable web: `/llms.txt`, `/llms-full.txt`, Agent Policy page, JSON-LD (SocialMediaPosting, DiscussionForumPosting, Comment, Person, Organization), stable URLs (`/p/:id`, `/c/:slug`, `/u/:handle`, `/d/:id`, `/poll/:id`, `/t/:topic`), `rel="next"` pagination alongside infinite scroll, `data-testid` + ARIA conventions for browser agents.

**Acceptance criteria**

- An external agent built only from the published docs and SDK can register, read feeds, post, vote, join a debate, and be revoked — with every action labeled and present in the audit log.
- A browser agent completes the core flows (sign up, post, reply, vote, debate turn) using only the UI, verified by an automated accessibility-driven test.
- Revoking an agent takes effect immediately across API, streaming, and MCP surfaces.

### Phase 5 — Social depth and scale

**Deliverables**

- DMs and group chats (text/image/video/voice notes, reactions, replies, read receipts, message requests, in-chat block/report; minors cannot receive DMs from non-followers).
- Advanced mod tools: full AutoMod (keyword/regex/account-age/karma rules), lockdown mode, scheduled/sticky posts, community insights, mod mail.
- Lists, scheduled posts, web push and email digests with per-type settings and quiet hours.
- Advanced ranking (ML-ready: impression/action logging from Phase 1 feeds model training), Perspective feature general availability, semantic search (pgvector), product analytics dashboards, i18n framework rollout beyond English.
- Load-test hardening (k6: feed reads, vote bursts, live-debate fan-out) against the 99.9% availability / API p95 < 300 ms SLO.

**Acceptance criteria**

- DM journeys (1:1, group, request → accept, block) pass E2E on desktop and mobile.
- Load test at the agreed target concurrency holds the SLO with no error-rate breach.
- Analytics dashboards report DAU/MAU, retention cohorts, debate completion rate, mind-change rate, report rate, time-to-moderation, and agent vs human activity split from real event data.

## 4. Milestones

| Milestone | Contents | Gate |
|---|---|---|
| M0 | Phase 0 docs + scaffold + staging hello-world | Owner approval of plan (hard stop) |
| M1 | Auth + identity (incl. genznewz linking) + profiles + follow graph | E2E auth journeys green |
| M2 | Posts/threads + communities + voting + feeds (Phase 1 complete) | Phase 1 acceptance criteria |
| M3 | Media pipeline + Reels + Stories (Phase 2 complete) | Phase 2 acceptance criteria |
| M4 | Polls + Daily Pulse | Brigading simulation test passes |
| M5 | Debate engine + Live Debate + article embed (Phase 3 complete) | Phase 3 acceptance criteria |
| M6 | Public API + SDKs + MCP + developer portal (Phase 4 complete) | External-agent acceptance test |
| M7 | DMs + advanced mod tools + push/digests | DM E2E green |
| M8 | Scale hardening + analytics + public launch readiness (Phase 5 complete) | Load test + SLO verification |

Milestones are sequential by dependency, not by calendar: no dates are committed until the owner approves Phase 0 and the hosting decision (§8) is made, because infrastructure choice changes the Phase 1 critical path.

## 5. Team split

Work is contract-first (per the master spec §18): the Architect publishes API_SPEC.yaml, DATA_MODEL.md, and the shared types in `packages/shared` before other roles build against them. One owner per directory; changes to shared contracts require the Architect's sign-off and a DECISIONS.md entry. Handoffs are written PR-style summaries; the Architect resolves conflicts.

| Role | Owns | Primary areas |
|---|---|---|
| Architect / Orchestrator | Plan, contracts, task board, integration, reviews | `docs/`, `packages/shared`, cross-cutting |
| Backend agent | API, auth, database, ranking, workers | `apps/api`, `apps/worker` |
| Frontend agent | Web app, components, state, PWA | `apps/web` |
| Design-systems agent | Tokens, components, motion, accessibility, screen designs | `packages/ui`, DESIGN_SYSTEM.md |
| Media / Realtime agent | Uploads, transcoding, HLS, WebSockets/SSE, live debates | media pipeline, realtime gateway |
| Trust & Safety agent | Moderation pipeline, classifiers, policies, abuse tooling | T&S services, policy pages |
| Agent-platform agent | Public API polish, SDKs, MCP server, developer portal, llms.txt | `packages/sdk`, `packages/mcp-server` |
| QA agent | Test strategy, E2E, a11y, load, security review | test suites across the repo |
| DevOps agent | CI/CD, IaC, environments, observability | infra, GitHub Actions, monitoring |

If the team is smaller than nine, roles merge in this order: Design-systems into Frontend; Media/Realtime into Backend; Agent-platform into Backend; QA and DevOps stay separate as long as possible because they are the independent checks on everyone else.

## 6. Definition of Done (per feature)

Schema and migration · API endpoint with OpenAPI entry · UI at all breakpoints with loading/empty/error states · keyboard and screen-reader support · authorization checks · rate limits · tests (unit, integration, E2E for key flows) · analytics events · docs updated · no console errors · feature flag where gradual release applies. No placeholder or lorem-ipsum screens in finished features.

## 7. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Scope size.** GG is three products plus two engines; underestimating any one phase slips all later ones. | High | Strict phase gates; each phase independently launchable; Phase 5 items are explicitly deferrable. |
| R2 | **Hosting on a home laptop.** Current staging is Amandeep's home laptop (shared with genznewz.com, residential IP, DDNS). Fine for staging; risky for a realtime social product (upload bandwidth, uptime, ISP changes). | High | Hosting is an explicit open decision (§8) with the spec default (Cloudflare + managed Postgres) costed before Phase 1 infra work. |
| R3 | **Identity mismatch with genznewz.com.** Existing reader accounts are a custom Laravel theme system (see ARCHITECTURE.md §9); a naive cookie-sharing SSO would be insecure and brittle. | Medium | GG becomes the OIDC provider; email-verified account linking for existing Members; no shared session cookies with the Laravel `member` guard. |
| R4 | **Abuse at launch.** A debate-and-voting platform is a brigading and sybil magnet from day one. | High | Trust tiers, vote audit log, anomaly detection, and voidable votes ship in the same phase as voting (Phase 3), not after; agent votes separated from human tallies by default. |
| R5 | **Moderation/legal exposure.** UGC at scale brings CSAM-hash-matching and reporting obligations (NCMEC in the US, Cybertip.ca in Canada), DMCA workflow, and minor-safety rules. | High | Hash-matching and takedown workflows are launch blockers for media (Phase 2), policy pages scaffolded early and flagged for legal review; minors' defaults are stricter by design. |
| R6 | **Age policy and launch regions undecided.** Minimum-age and regional rules affect onboarding, DMs, and discoverability. | Medium | Build age-gating and region configuration as settings from Phase 1 so a late legal decision is a config change, not a rewrite. Decision needed before public launch (§8). |
| R7 | **Video cost/complexity.** Transcoding, storage, and egress for Reels/Stories can dominate infra cost. | Medium | Transcoding behind an adapter (self-hosted ffmpeg workers vs Mux/Cloudflare Stream) so the provider can change on cost data; aggressive rendition ladders and CDN caching. |
| R8 | **Ranking trust.** An opaque "For You" feed undermines the transparency principle and invites outrage amplification. | Medium | Heuristic ranker with published factors, "Why am I seeing this?", chronological option, no ranking on raw comment count. |
| R9 | **Key-person/bus factor.** Small team, one owner-operator for the host infrastructure today. | Medium | Everything in git + docs (PROGRESS/DECISIONS/RUNBOOK), IaC for environments, restore-tested backups. |
| R10 | **Agent-platform misuse.** Open APIs and MCP access invite spam farms wearing "agent" labels. | Medium | Owner-linked accountability, earned rate tiers, instant kill switch, full audit log, separate vote tallies. |

## 8. Open decisions (owner input needed; non-blocking for Phase 0)

From the master spec §17. Defaults are used until answered; only the items marked ⛔ gate the phase noted.

1. **Platform name and subdomain** — ✅ Resolved 2026-10-10: name **GG**, subdomain **gg.genznewz.com**.
2. **Brand colors/fonts** — Default in use: derived from the live genznewz.com theme (Space Grotesk display, Inter body, IBM Plex Mono; amber accent #ffbf47 on ink #111827; see DESIGN_SYSTEM.md). Owner may override before Phase 1 UI work.
3. **Hosting** — ✅ Resolved 2026-10-10 by the owner: **all on the laptop** (option c). Postgres and Redis co-located with the apps behind Cloudflare; the managed-hosting default is shelved unless he revisits it. Capacity risk R2 stands and is mitigated, not eliminated. See DECISIONS D-010.
4. **Minimum age policy and launch regions** — ✅ Resolved 2026-10-10: the owner delegated the age call; set to **minimum age 13** with the spec's stricter 13–17 defaults, launch regions Canada + US at baseline. Still flagged for legal review before public launch (COPPA, PIPEDA, Quebec Law 25 nuances). See DECISIONS D-011.
5. **genznewz.com account reuse** — ✅ Resolved by inspection 2026-10-10: reader accounts exist but are a custom Laravel theme system that cannot share sessions with GG. Decision adopted: GG is the identity provider (OIDC); existing Members link accounts via verified email. See ARCHITECTURE.md §9.
6. **Video provider** — Self-hosted ffmpeg workers vs Mux vs Cloudflare Stream. Default: build the adapter in Phase 2 and start self-hosted; revisit with real usage/cost data.
7. **AI provider(s)** for summaries, captions, alt text, moderation assist — Default: provider-agnostic interface, no vendor selected until Phase 2 needs one. All AI features optional and labeled.
8. **Agent vote weight** — ✅ Resolved 2026-10-10 by the owner: **agent votes count the same as human votes** (weight 1.0) in rankings, polls and debates. Supersedes the spec default. Tallies remain broken out by author type in displays for transparency. See DECISIONS D-012.

## 9. Working rules

- Plan before code; vertical slices; nothing half-built left behind.
- PROGRESS.md and DECISIONS.md are updated in the same change as the work they describe.
- Never fabricate: no fake keys, no claimed test results without running them; `.env.example` documents every secret.
- Quality bar: type-safe, tested, accessible, secure by default, documented.
- Milestone reports follow the format: **Done / How to run it / What's next / Risks / Questions for me.**

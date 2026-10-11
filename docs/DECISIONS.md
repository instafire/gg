# GG — Decision Log

Every non-obvious choice, with the reason and the alternatives rejected. Newest last.
Format: ID, date, decision, reason, alternatives rejected. Other docs cite these IDs — never renumber.

---

## D-001 — 2026-10-10 — Working name "GG", subdomain gg.genznewz.com
- **Decision:** The platform's working name is **GG** and it ships at **gg.genznewz.com**, per Amandeep's direct instruction.
- **Reason:** He named the subdomain; "GG" (good game) fits a debate/opinion platform and Gen Z vocabulary. Name is a working name until he confirms it as the brand.
- **Alternatives rejected:** Inventing a separate brand name (not my call — brand choices are his per the build rules).

## D-002 — 2026-10-10 — Staging/hello-world hosted on Amandeep's laptop, same pattern as ads.genznewz.com
- **Decision:** gg.genznewz.com DNS (Cloudflare A record `29a6c4899a98a0706b84989561416f15`, proxied) points at the laptop (76.64.218.200); nginx vhost serves a static hello-world from `/home/genznewz/htdocs/gg.genznewz.com`; Let's Encrypt cert via certbot; record added to the laptop's DDNS updater (`~/bin/cf-ip-watch.py`) so ISP IP rotations self-heal.
- **Reason:** Matches how genznewz.com, ads.genznewz.com and askmya.online already run; zero new cost (free-only rule); gives Phase 0 its "running hello world on the subdomain" deliverable today.
- **Alternatives rejected:** Cloudflare Pages/Workers for staging (splits the eventual app topology; the production hosting decision is still open — see D-004).

## D-003 — 2026-10-10 — ORM/migrations: Drizzle
- **Decision:** Drizzle ORM with drizzle-kit migrations for all Postgres access.
- **Reason:** SQL-first and type-safe end to end, migrations are plain reviewable SQL that can roll back, no runtime schema engine in production, and it handles the raw-SQL cases this schema needs (ltree operators, Wilson-score and hot-ranking expressions, partial indexes) without fighting an abstraction.
- **Alternatives rejected:** Prisma (heavier runtime, migration diffing is weaker for expression/partial indexes and extension types like ltree/pgvector); hand-written SQL only (loses type safety and shared zod-schema reuse between API and DB layers).

## D-004 — 2026-10-10 — Production hosting left as an open decision, spec default recorded
- **Decision:** Docs record the spec default (Cloudflare edge + managed Postgres) as the production candidate, but no production hosting is committed until Amandeep answers.
- **Reason:** His fleet today is one home laptop behind a residential connection; a public social platform with uploads/realtime will outgrow that. This is a money/capacity decision that is his to make.
- **Alternatives rejected:** Silently assuming the laptop is production (it cannot serve video transcoding + websocket fan-out + a public launch safely); silently assuming paid cloud (free-only rule, no spend without his approval).

## D-005 — 2026-10-10 — GG is the identity provider; genznewz.com members link by verified email
- **Decision:** GG implements OIDC and becomes the identity provider ("Sign in with GG" can be offered back to genznewz.com later). Existing genznewz.com member accounts are **linked, not merged**: a GG signup with a matching verified email is offered a link flow (prove control of the genznewz password or via an email token sent to that address), after which the identities are associated in GG.
- **Verified facts behind this:** genznewz.com reader accounts are a custom system built into the Botble "newspaper" theme — a Laravel `member` guard with model `Theme\Newspaper\Models\Member`, email+password, session cookies scoped to genznewz.com only. There is no OAuth/OIDC provider and no parent-domain (`.genznewz.com`) session cookie.
- **Reason:** Sharing the Laravel session across subdomains is not viable (different stack, session format and cookie scope; would require modifying the production news site's auth). OIDC + linking gets one identity without touching genznewz.com's working auth.
- **Alternatives rejected:** Parent-domain cookie SSO (not technically available — the cookie is host-scoped today and the session payloads are Laravel-specific); password import/hash migration (never move password hashes between systems when a link flow works); leaving the two account systems permanently separate (breaks the "News-to-debate" flow's identity story).

## D-006 — 2026-10-10 — Repo scaffold and CI deferred until the Phase 0 summary is approved
- **Decision:** Phase 0 docs are delivered first, per the build rule "produce the docs, STOP, present a summary for approval." The monorepo scaffold, CI pipeline and design-token package (also listed as Phase 0 deliverables in the roadmap) start immediately after approval.
- **Reason:** His rule 1 is explicit about the order; the hello-world + DNS + hosting (separately ordered by him: "make a new subdomain gg.genznewz.com") were done now because they are infrastructure, not application code.
- **Alternatives rejected:** Scaffolding the monorepo in the same pass (violates the approval gate he set).

## D-007 — 2026-10-10 — Comment trees stored with ltree paths on the unified Post model
- **Decision:** Replies/comments are Posts carrying `parent_id`, `root_id` and an **ltree** `path`; subtree reads and depth pagination use GiST-indexed ltree operators.
- **Reason:** One conversation model serves X-style replies and Reddit-style unlimited-depth threads; ltree gives O(1)-ish subtree fetches and stable ordering without recursive CTEs on the hot path. Tombstone soft-deletes preserve thread structure (matches Reddit semantics).
- **Alternatives rejected:** Closure table (insert cost grows O(depth) with extra rows per ancestor — bad for unlimited-depth viral threads); adjacency list + recursive CTE only (correct but slow and awkward to paginate at depth); nested sets (write amplification on every insert).

## D-008 — 2026-10-10 — Brand derived from genznewz.com's live theme, not invented
- **Decision:** DESIGN_SYSTEM.md tokens are taken from the live genznewz.com "newspaper" theme CSS: Space Grotesk display / Inter body / IBM Plex Mono; accent #ffbf47; ink #111827; focus #2e5cff; dark surface #121212; radius 16px.
- **Reason:** The spec says derive brand from genznewz.com; the values above were read from the production stylesheets on 2026-10-10, not guessed.
- **Alternatives rejected:** A fresh palette (would read as a different company; brand choices are his).

## D-009 — 2026-10-10 — Name confirmed: GG
- **Decision:** "GG" is the platform's name (no longer a working name), confirmed by Amandeep.
- **Reason:** His call, given with the Phase 0 approval.

## D-010 — 2026-10-10 — Production hosting: Amandeep's laptop (supersedes D-004)
- **Decision:** GG production runs on the same laptop as genznewz.com: Next.js web, Fastify API, BullMQ worker, Postgres and Redis co-located as systemd services behind the existing Cloudflare proxy and nginx. The spec default (Cloudflare + managed Postgres) is shelved unless he revisits it.
- **Reason:** His explicit instruction ("host it on laptop"), consistent with how genznewz.com, ads.genznewz.com and genztv.live already run and with the free-only rule.
- **Recorded consequences (accepted with the decision):** single residential box = single point of failure; upload/realtime capacity is bounded by home bandwidth and one machine; mitigations are part of the build, not optional — automated off-box Postgres backups with restore tests, Cloudflare caching for media/static, systemd restart policies, and the DDNS self-heal already in place. Revisit trigger: sustained traffic or uptime pain.
- **Alternatives rejected:** Managed cloud hosting (his call against it); splitting only the DB to a managed service (same — revisit later if needed).

## D-011 — 2026-10-10 — Minimum age 13 (decided by Mya, delegated by Amandeep)
- **Decision:** Minimum age **13**. Ages 13–17 get the spec §10 stricter defaults (private-ish profile, no DMs from non-followers, no location sharing, limited discoverability). Launch regions at baseline: Canada + US.
- **Reason:** Amandeep delegated the call ("min age you decide"). 13 matches the spec floor and the COPPA baseline; anything lower invites legal exposure, anything higher cuts the Gen Z audience the product is built for.
- **Flagged, not blocking:** regional law varies (Quebec Law 25, EU digital-consent ages 13–16 by member state) — legal review before public launch and before any EU targeting; region gating stays a config flag so the floor can rise per-region without a rebuild.

## D-012 — 2026-10-10 — Agent votes count the same as human votes (supersedes spec §6.1 default)
- **Decision:** Agent votes carry weight **1.0 — identical to human votes** — in post/comment scores, poll results, debate winner computation and rankings. Implemented as config (`AGENT_VOTE_WEIGHT=1.0`) so it can change without a migration.
- **Reason:** Amandeep's explicit instruction ("agent votes count same as humans").
- **What does NOT change:** agents stay visibly labeled everywhere (non-removable AI badge, `author_type` on every API response), tallies are still computed and displayed split by author type so anyone can see the human-only number, the "Hide AI accounts" filter stays, and agents remain owner-linked with earned rate tiers, a kill switch and a full audit log.
- **Recorded consequence:** with equal weight, vote integrity becomes load-bearing — trust-tier gating on what counts, anomaly/brigade detection, and void-and-recompute from the immutable vote audit log ship in the same phases as voting, never after.
- **Alternatives rejected:** The spec default (separate AI tally, weight 0) — overridden by the owner.

## D-013 — 2026-10-10 — Phase 1 slice 1 schema/implementation concretizations
- **Decision:** Where DATA_MODEL.md left shape choices open, slice 1 fixes them as follows: (a) password hashes live in a dedicated `credentials` table (one row per user) rather than on `users`; (b) `citext` columns are implemented as `text` with app-level lowercase normalization + unique indexes (identical semantics for handles/slugs/emails at our scale, one less extension dependency in migrations); (c) `profiles.avatar_media_id` / community icon/banner ids are plain uuid columns until the media table lands in Phase 2, when the FKs are added; (d) posts self-referencing FKs (parent/root/quoted/repost), the agent-owner CHECK, pair-distinctness CHECKs, `updated_at` triggers, the `author_type` immutability trigger and the no-self-vote trigger are hand-written SQL appended to the drizzle-kit migration; (e) access tokens are HS256 JWTs (SECURITY §3.4 left the algorithm to Phase 1; single-host deployment per D-010 makes a shared secret appropriate — RS256 + `kid` rotation is the recorded hardening step before any multi-host future).
- **Reason:** Each item is the smallest faithful realization of the data-model contract; deviations are mechanical, not semantic.
- **Alternatives rejected:** citext extension (extra moving part for zero behavioral gain given app normalization); deferring the integrity triggers to the service layer (DATA_MODEL §13: constraints are truth, app checks are UX).

## D-014 — 2026-10-10 — Post-vote counting is not trust-tier gated in slice 1
- **Decision:** Up/down votes on posts count for every registered account tier in slice 1. The SECURITY §6.1 "T0 votes not counted" rule is applied where it protects tallies that matter — polls and debate stance votes (minimum tier T1 by default in DATA_MODEL §6.1) — when those engines land in Phase 3.
- **Reason:** Email verification does not exist yet in slice 1, so every account is T0; gating post votes on tier would make voting (a Phase 1 acceptance behavior) unusable end-to-end. Post scores remain fully recomputable from `votes` + `vote_audit`, so a stricter gate can be applied retroactively without data loss.
- **Alternatives rejected:** Auto-promoting registrations to T1 (false signal — tier must mean "email verified"); blocking votes until the email slice lands (stalls Phase 1 acceptance).

## D-015 — 2026-10-10 — Wire format follows the @gg/shared DTOs; auth envelope follows API_SPEC
- **Decision:** Resource responses serialize through the `@gg/shared` camelCase DTOs (the scaffold's declared single source of truth for web/api/sdk). The auth token envelope keeps the API_SPEC snake_case field names (`access_token`, `refresh_token`, `token_type`, `expires_in`) because OAuth-shaped clients expect exactly those. Request bodies accept both camelCase and the API_SPEC snake_case aliases for the same fields.
- **Reason:** The Phase 0 scaffold (approved after the spec) standardized on shared DTOs; auth is the one surface with an external convention worth matching literally.
- **Alternatives rejected:** Pure snake_case everywhere (fights the shared package + web code); pure camelCase including tokens (breaks OAuth client expectations for the future OIDC surface, D-005).

## D-016 — 2026-10-10 — Counters are transaction-maintained in slice 1 (async worker counters deferred)
- **Decision:** Post/user/community counters are updated synchronously inside the same transaction as the write that causes them (votes even write `vote_audit` in that transaction, per the task contract). This deviates deliberately from DATA_MODEL §0.5's async counter-events design. The worker keeps a `counter.reconcile` job name reserved for the recompute-from-source sweep.
- **Reason:** At dev/single-host scale, in-transaction counters are simpler and can never drift from the source rows they summarize; integrity (the load-bearing part under D-012) is unaffected because counters are always derivable. The async design exists for write throughput we do not have yet.
- **Alternatives rejected:** Building the BullMQ counter pipeline now (premature scale work; delays the vertical slice); skipping audit-in-transaction (violates the integrity contract).
- **Revisit trigger:** vote/write throughput where counter row-locking shows up in profiles, or the multi-host move.

## D-017 — 2026-10-10 — `posts.score` is double precision; `reply_count` counts descendants
- **Decision:** `score` stores the weighted vote sum as `double precision` (raw `up_count`/`down_count` stay integer ballot counts). `reply_count` means total live descendants of the post (seed and API agree; maintained via one ltree prefix UPDATE on reply creation).
- **Reason:** AGENT_VOTE_WEIGHT is config (D-012) — a fractional future weight must not corrupt the score type; integrity displays use the ballot counts (DATA_MODEL §13.4), so a float score loses nothing. Descendant-count is the number thread UIs actually render.
- **Alternatives rejected:** Integer score with rounding per vote (compounding error under fractional weights); direct-replies-only reply_count (root posts would under-report thread size vs the seed/recompute semantics).

## D-018 — 2026-10-10 — Wire format is API_SPEC exactly (supersedes D-015)
- **Decision:** All API responses use the API_SPEC.yaml shapes literally: snake_case fields, `{ data, page: { next_cursor, has_more } }` list envelopes, FeedItem `{ post, why }`, Post `viewer_state`, VoteSummary `viewer_vote` as `up|down|null`. Canonical feed routes are `GET /feed?tab=for_you|following` and `GET /explore`; `/feed/home` and `/feed/explore` remain as aliases. `for_you` v1 = the ARCHITECTURE §7.1 candidate mix (followed 40% / communities 30% / exploration) served hot-ordered (§7.2 formula) with per-item `why` — the transparent heuristic, not a learned ranker. `down_count` follows the spec display rule (null for non-authors on personal timelines) in both Post and VoteSummary.
- **Reason:** The frontend slice builds against the spec via @gg/sdk; two wire dialects (D-015's shared-DTO camelCase) would force every consumer through translation. The spec is the contract; @gg/shared DTOs remain the web-side internal model, bridged by the SDK normalizers.
- **Alternatives rejected:** Keeping camelCase DTOs on the wire (breaks the frontend's spec-first client); dropping the /feed/home + /feed/explore aliases (kept — they cost nothing and the original brief named them).

## D-019 — 2026-10-10 — SDK fetch must be bound; every phase gets a real-browser check
- **Bug found in staging (2026-10-10, ~1h hunt):** the web app showed "Can't reach the GG API" on every data page while the API was verifiably healthy via curl/Node and all 30 backend + 19 SDK tests passed. Root cause: `@gg/sdk` stored `globalThis.fetch` unbound and called it as a client method — browsers throw `TypeError: Illegal invocation` for unbound `window.fetch`; Node's fetch doesn't care, so no test caught it. The throw happened before any network dispatch, which is why server logs showed zero browser API calls.
- **Fix:** `globalThis.fetch.bind(globalThis)` in the GGClient constructor + a regression test that emulates window.fetch receiver semantics (SDK tests 20/20 after).
- **Standing rule from this:** unit/integration tests and curl are NOT sufficient verification for web work — every phase ends with a real-browser pass (headless Chromium probe at minimum) against the deployed staging URL before it's called done. Also adopted during the hunt: Cloudflare Rocket Loader rewrites this zone's script tags and breaks Next.js; the gg vhost now injects `data-cfasync="false"` via nginx sub_filter (config-rules APIs are outside the current Cloudflare token's scope).

## D-020 — 2026-10-10 — Contract audit closes the SDK↔API phantom routes (integration-gap round)
- **Trigger:** live browser verification (per the D-019 rule) found the community page erroring — the frontend called the spec's `GET /api/v1/communities/:slug/posts` (`?limit=20&sort=hot`) but backend slice 1 never registered it. A systematic diff of every @gg/sdk call against the API's registered routes found 8 phantom routes total.
- **Implemented (all Phase 1):** `GET /communities/:slug/posts` (community-filtered, top-level only, sorts hot/new/top/rising/controversial, `window` for top, `flair_id` filter, blocked/muted-author + hide-AI filters for signed-in viewers, PostPage envelope with `vote_breakdown`; 404 unknown slug; **403 for private communities when the viewer is not an active member** — the community detail route stays lenient so the page can offer join, its posts do not); `GET /communities` (discovery list, `q`/`topic`, private hidden from non-members); `GET /users/:handle/posts` (tabs posts/replies/media/debates; non-self viewers see public+community visibility only); `GET /posts/:postId/replies` (direct replies; best/top/controversial by offset over score, new by keyset); `GET /posts/:postId/subtree` (ltree descendants, `depth` re-based to the subtree root per spec, max_depth clamp 10); `PATCH /posts/:postId` (author-only; 409 on deleted/locked/removed; body re-rendered; sets `edited_at`, increments `edit_count`); `GET /users/me/bookmarks` (keyset on saved-at, hydration preserves order).
- **Deferred by name:** SDK `listPosts` → `GET /api/v1/posts`. The spec's `/posts` is POST-only and no web surface calls it; the SDK method is a legacy pass-through. Implement only if a real consumer appears.
- **Adjacent contract bug fixed:** SDK `followUser` dereferenced `raw["state"]` but the API answers **204 No Content** and the SDK's `request()` returns `undefined` for 204 → TypeError in the browser. Guarded via `isWire` (default `following`) + SDK regression test with a mocked 204.
- **Sorting approximations (accepted for Phase 1):** hot/rising/controversial and reply best/top sorts page by offset over time-varying score keys (same approach as `for_you`/explore); new/top and all profile/bookmark lists use stable keyset cursors.
- **Edit window:** API_SPEC's `PostUpdate` carries no edit-window field; no time limit on editing own posts is enforced this slice. Revisit in Phase 5 moderation work if abuse appears.
- **Verification:** repo-wide typecheck green; SDK 21/21; API **38/38 on the laptop against `gg_test`** (staging `gg_dev` untouched). Pre-existing lint debt noted, not introduced here: 2 `no-unused-vars` errors for `_reply` in `src/lib/auth.ts`.

## D-021 — 2026-10-10 — Phase 1 round 2: notifications, search, onboarding, settings
- **Scope:** the remaining Phase 1 round (media attachments stay Phase 2) — notification generation + endpoints, Postgres-native search, onboarding, and the full settings surface, API + SDK + web. Migration `0001_pretty_fallen_one.sql` + hand-appended SQL (pg_trgm, `posts.search_vector` generated tsvector + GIN, trigram GINs on handle/display_name/slug/name) — drizzle-kit cannot model generated columns or trigram GIN indexes; schema.ts notes this.
- **One notification service:** every producer (follow, reply, mention, vote milestone, private-community join request) calls `notify()` inside the producer's own transaction (`apps/api/src/services/notifications.ts`). Generation is gated by the recipient's per-type prefs and mention policy at write time. Dedupe: same recipient+actor+type+subject within 1h folds into the existing row (`group_count` +1, payload refreshed, `read_at` reset so the fold re-surfaces unread). Vote milestones (10/25/100 lifetime upvotes) are exempt from the window and fire exactly once per threshold ever.
- **Quiet hours stored, not enforced:** no push/delivery layer exists yet; suppressing row creation would silently drop unrecoverable notifications. Rows always collect; quiet hours will gate delivery when that layer lands.
- **Mentions:** parsed from post bodies at write time, indexed into `post_mentions` (DATA_MODEL §3.4), one mention notification per mentioned active user; the parent-post author gets the reply notification instead of a duplicate mention. **Quote notifications not wired** — the spec enum has no quote type and Phase 1 has no quote-creation endpoint; revisit with Phase 2 quote work.
- **Join requests:** a `pending` join to a private community notifies owners/admins/moderators (`system`, `payload.kind = join_request`). Approval/decline outcome notifications wait on the mod membership-request endpoints, which do not exist yet.
- **Search:** spec envelope `{posts, people, communities, hashtags: [], debates: []}`. Posts rank by Postgres FTS (`plainto_tsquery` + `ts_rank` over the generated vector; title weight A, body weight B) — in practice this supersedes the spec §0 "BM25 approximated by ts_rank" interim note until the Phase 3 OpenSearch move. People/communities match ilike + pg_trgm similarity > 0.25. Rank is query-dependent, so group cursors are offsets and address only the primary group (other groups return page 1) — same client-visible contract as the reply-tree cursor. Missing/blank `q` → **400** problem+json per this round's brief (other validation stays 422). `GET /search/suggest` backs future typeahead.
- **Settings/account routes under both prefixes** (`/users/me/*` per spec and `/me/*` per this round's brief), following the existing me-alias pattern. New endpoints added to API_SPEC.yaml this round (131 paths): `/notifications/preferences`, `/onboarding/suggested`, `/onboarding/complete`, `/users/handle-available`, `/users/me/change-password`, `/users/me/email-change`.
- **Profile vs settings split:** profile text fields (display name, bio, location, website, avatar/banner media ids) stay on `PATCH /users/me`; the settings PATCH additionally owns `is_private` and everything on `user_settings` (incl. new `preferences` jsonb, `font_scale`, `high_contrast`, `reduced_motion`). One writer per field.
- **Change-password keeps the caller's session:** every refresh family except the one containing the access token's `sid` is revoked. **Email-change is record-only** (202; `email_change_requests` row, SHA-256 token hash, 24h expiry) — no mailer or confirm endpoint until the email slice.
- **Deactivation deviation (deliberate):** the spec's "reversible by logging back in" note conflicts with this round's acceptance test — login is blocked while deactivated (login 403, refresh 401), all sessions are revoked, and the account's posts/profile disappear from feeds, search, and profile surfaces (`hiddenAuthorIds` + search filters). A reactivate flow is future work; until then reactivation is an operator action.
- **Frontend:** register routes fresh accounts to `/onboarding` (3 steps: topics → communities → people; Skip also completes with the current topic selection so the `onboarding_completed_at` guard can never trap a user; completed users bounce to `/home`). Notifications page replaces the placeholder (type icons, unread highlight, group chips, mark-all + per-item read, target links). The AppShell badge refreshes on navigation and on a `gg:notifications-changed` window event. Deactivate uses the DESIGN_SYSTEM hold-to-confirm (1.5s press-and-hold with progress fill; keyboard hold works).
- **Verification:** repo typecheck green; SDK 30/30; API **50/50 on the laptop against `gg_test`** (12 new tests in `test/phase1b.test.ts`: follow→notification + unread_count, 1h dedupe fold, prefs gate, read-all, mention + post_mentions, 10th-upvote milestone exactly once, FTS post + trigram user search, empty-q 400, onboarding persists topics, handle availability, settings round-trip, change-password revokes the second session (401) while the current one survives, email-change 202 + taken-409, deactivate blocks login and hides posts from search); web `next build` green with /search, /onboarding, /settings, /settings/privacy, /settings/account routes. Lint: web + SDK clean; API shows only the 2 pre-existing `_reply` errors (D-020 debt). **Not deployed** — gg_dev migration + service restart are the parent's deploy step; per D-019 the real-browser pass happens after deploy.

## D-022 — 2026-10-10 — OAuth, passkeys, TOTP deferred to the hardening phase
- PLAN.md lists OAuth (Google/Apple/Discord), WebAuthn passkeys, and TOTP 2FA among Phase 1 auth deliverables. Slice 1 shipped email+password (argon2id) with refresh rotation; the full-journey acceptance test runs on that. Decision (mine, under the owner's autonomy directive): defer OAuth/passkeys/TOTP to the final production-hardening phase, after the opinion/debate engine exists — they are additive auth methods that touch none of the social/opinion data model, and the test-ready milestone is gated on the core product, not on login variety. The schema already carries `has_passkey`/`totp_enabled` flags and trust tiers anticipate them (T2 = passkey/phone verified). Recorded here so the deferral is explicit, not silent scope loss.

## D-023 — 2026-10-10 — Phase 1 exit round: reports semantics + two contract bugs the E2E caught
- **Duplicate reports:** `POST /api/v1/reports` returns **200 with the existing report** when the same reporter already has an open/triaged report on the same target (the spec's `GET /reports/{id}` example documents 200-with-existing; no 409 shape exists for creation). Scope is (reporter, target_type, target_id) so a resolved report never blocks a fresh one.
- **Spec gap filled:** API_SPEC.yaml defined report creation/read and the mod queue but **no resolve endpoint**; added `PATCH /api/v1/reports/{reportId}` (`resolveReport`) with the ReportStatus transition open/triaged → triaged/actioned/dismissed/closed, terminal states stamping resolved_by/resolved_at; re-resolving a terminal report is a 409. YAML re-validated (131 paths).
- **Reports without an owning community** (user targets, profile-level posts): no community moderators exist to resolve them, so `PATCH` returns 403 and they collect for the future platform-admin tooling rather than pretending a queue owns them. Message/argument/debate target types return 422 — those entities do not exist until Phase 3/5.
- **Severity ordering** for the mod queue is a static reason→severity map (self_harm 4; violence/threats, hate_speech, sexual_content 3; spam 1; everything else 2). No AutoMod exists yet, so the queue's `kind=held` filter honestly returns an empty page.
- **BUG (pre-existing): PostCreate contract.** The spec promises `parent_id`/`quoted_post_id`/`repost_of_id` on `POST /api/v1/posts` ("one endpoint covers all content"), but the route's zod schema omitted all three and silently stripped them: web/SDK replies persisted as **root posts** (the thread UI's optimistic prepend masked it locally; no thread linkage, no reply notification) and **reposts always failed** (empty body → 422). Fixed: route accepts both casings, service resolves quote/repost targets and bumps quote_count/repost_count, reposts exempt from the empty-body rule, reply char limit = 500. Regression tests in `test/post-create-contract.test.ts`. Note: the dedicated `POST /posts/:postId/replies` route never had the bug, which is why API-level tests never saw it. Known inconsistency left alone: neither reply path adds a community-membership gate beyond creation rules.
- **BUG (pre-existing): CORS methods.** The @fastify/cors registration inherited an allow-methods of GET,HEAD,POST only, so **every browser PUT/PATCH/DELETE failed preflight** — votes, follow/unfollow, join/leave, settings saves, bookmark toggles, report resolution all errored in real browsers while curl/Node tests passed (same blind spot as D-019). Fixed with an explicit methods list in `apps/api/src/app.ts` + a preflight regression test (OPTIONS must allow PUT/PATCH/DELETE).
- **E2E topology:** the Playwright suite runs on the laptop against dedicated gg_test-backed instances (api :4100, web :3202 with `NEXT_DIST_DIR=.next-e2e`) so staging data stays clean; `next.config.ts` gained the NEXT_DIST_DIR override to make that safe. Both staging bugs above are therefore ALSO live on the current staging deploy until the parent ships this round.
- **D-023 addendum (LCP/CLS):** thread-page LCP measured 3,048 ms under mobile lab conditions (Slow-4G + 4× CPU) vs the 2,500 ms budget — a miss, recorded plainly. The LCP element waits on client-side fetching (HTML → JS → session → thread fetch → render); closing it needs server-rendered first paint for thread/explore, which is Phase 2+ architecture work, not an exit-round tweak. CLS is 0.000 on login/explore/thread. Lighthouse proper is blocked in this environment by a Chromium 148 CDP-WebSocket fault (see PROGRESS.md); numbers come from PerformanceObserver under Lighthouse-equivalent throttling.

## D-024 — 2026-10-10 — Phase 1 exit: accepted with thread-LCP carried into Phase 2
- Exit review vs PLAN.md Phase 1 acceptance: journey E2E 6/6 (desktop + Pixel 7), axe zero critical/serious on 6 routes, feed p95 27–28 ms vs 400 ms budget, CLS 0.000 everywhere. LCP (lab, throttled): /login 552 ms ✓, /explore 2,448 ms ✓ marginal, **thread 3,048 ms ✗** — the thread page is client-fetch-bound (loading skeleton → fetch → paint).
- Decision: Phase 1 closes; the thread-LCP fix (server-render the thread's first paint / SSR the root + first replies) is carried into Phase 2 as an explicit task, since Phase 2 already reworks post rendering for media. Not a waiver — a scheduled fix with an owner (Phase 2 round) and a re-measure at Phase 2 exit.

## D-025 — 2026-10-11 — Phase 2 media intake: dual transports, honest "signed" URLs, spec deltas
- **Two intakes, one canonical pipeline.** `POST /api/v1/media/uploads` serves the spec's JSON session flow (tus-style PATCH chunks + one-shot PUT to the signed-PUT URL + `POST …/complete`) and additionally accepts a one-shot `multipart/form-data` upload on the same path (single file part; session row, streamed store, finalize — all in one request). Both feed the same finalize gate (size check → magic-byte sniff vs the declared type → worker pipeline), so there is exactly one place where bytes become media.
- **The signed-PUT URL is not an S3 presign.** The storage adapter is local-disk; its "signed_put_url" is an authenticated API URL (`/api/v1/media/uploads/{id}/content`) guarded by the owner's session. Session URLs are path-absolute by design so they work behind the staging proxy without origin guessing. When an S3 adapter lands, the same field becomes a real presigned URL with no wire change.
- **File serving is an API route, not nginx:** `GET /media/{id}/{variant}`, `GET /media/{id}/hls/{file}`, `GET /media/{id}/captions/{lang}` (documented in API_SPEC.yaml under createMediaUpload). Gate: media `ready` AND scan verdict `clean` — anything else 404s, including in-flight, quarantined and rejected media. Immutable cache headers on renditions/segments; playlists 60 s. The web app proxies `/media/*` to the API via a Next rewrite so browser URLs stay same-origin.
- **Spec delta:** the Phase 0 spec had REEL posts and a /reels player surface but **no reels feed path**; added `GET /api/v1/reels` (PostPage envelope, keyset cursor) — spec now 132 paths, YAML re-validated.
- **Post/media rules:** media_ids ≤ 10, all rows must be `ready` and owned by the author (403 otherwise). IMAGE = exactly 1 image, CAROUSEL = 2–10 images, VIDEO = 1 video, REEL = 1 video ≤ 180 s (D-026); TEXT/LINK may carry media as attachments without count rules. Alt text lives on the media row (`PATCH /api/v1/media/{id}`, source `user`).
- **Intake sniff is repeated in the worker scanner** (defense in depth): a file is validated at complete-time in the API and again before processing; either failure marks the row `rejected` and moves the bytes under `quarantine/` — a blocked file is never publicly reachable (integration-tested with an MZ executable declared as PNG: complete → 422, file route → 404).

## D-026 — 2026-10-11 — Size caps follow the spec, not the phase brief
- The Phase 2 brief recalled "video 512 MB"; API_SPEC.yaml (the wire contract, D-018) says **images ≤ 25 MB, video ≤ 2 GB**. The spec wins. Caps are enforced three times: at session creation (declared size → 413), while streaming (multipart/PUT), and at complete (actual ≠ declared → 422). Per-user quota 2 GiB of non-failed media and 60 upload sessions/hour are config (`MEDIA_QUOTA_BYTES_PER_USER`, `MEDIA_UPLOADS_PER_HOUR`).
- **Reel cap:** REEL posts reject video longer than 180 s at attach time (probed duration), matching the short-form surface. Longer video belongs in VIDEO posts.

## D-027 — 2026-10-11 — Moderation gate: structural scan is real, NSFW is an honest stub
- Every upload passes the local scanner before any byte is public: executable-signature blocklist (MZ/ELF/shebang/Mach-O), magic-byte sniff vs declared MIME, and a decode check (sharp metadata for images, ffprobe for video). Failures → verdict `rejected`, bytes quarantined, never served.
- **The NSFW/gore classifier is a stub and says so.** `LocalScanner` emits `content_labels = { classifier: "stub-passthrough-v1", nsfw: null, gore: null }` — nulls, not invented scores. The scanner-adapter interface is shaped so a real classifier can drop in without touching the pipeline. No fake "AI moderation" claims anywhere in the UI or docs.

## D-028 — 2026-10-11 — Captions: plumbing real, transcriber stubbed (free-only rule)
- The caption track pipeline is fully wired: the transcoder adapter asks a `TranscriberAdapter` for tracks, writes WebVTT sidecars under `media/{id}/captions/{lang}.vtt`, stores them on the media row, the API serves them, the SDK surfaces them, and the web player renders `<track kind="captions">`.
- **The transcriber itself is `StubTranscriber`, which returns an empty track list** — no external speech-to-text service (paid/metered services are out per the standing free-only rule). Swapping in a local Whisper model later is a one-adapter change; until then videos simply have no caption tracks, and nothing in the UI pretends otherwise.
- **Named deferrals (Phase 2):** in-app image editor (crop/rotate/filters) and AI alt-text drafts from PLAN Phase 2 are deferred (alt text is manual; the row's `alt_text_source` anticipates an `ai_draft` value). Story Highlights deferred — stories core shipped. Muted preview clip (`preview` variant) not produced. **Audio uploads return 422** in Phase 2 (`media_kind` reserves the value; no audio surface exists yet).

## D-024 follow-up — 2026-10-11 — thread LCP closed in Phase 2
- The carried item is done: the thread page now server-renders the root + first replies (`post/[id]/page.tsx` server component fetching anonymously, `ThreadClient` hydrating and patching viewer state once the session resolves). Re-measured with the identical lab method (mobile 412×915, 4× CPU throttle, Slow-4G 1.6 Mbps/150 ms, PerformanceObserver; probe kept as `e2e/tools/lcp-probe.mjs`): **median 856 ms** over 3 runs (712/856/908) vs 3,048 ms at Phase 1 exit — inside the 2,500 ms budget with room. Explore's marginal 2,448 ms was not re-measured this round (unchanged code path); re-check at Phase 3 exit.

## D-029 — Phase 3 polls: spec names win over the brief's labels (2026-10-11)
The Phase 3 brief used enum labels from the master plan (SINGLE/MULTI/RANKED/
STANCE/IMAGE/HOT_TAKE; LIVE/HIDDEN_UNTIL_VOTED/HIDDEN_UNTIL_CLOSE; stance
slider −100..+100; 1,500-char turns). API_SPEC + DATA_MODEL are canonical
(D-018): poll types are `single|multiple|ranked|stance_slider|image|hot_take`,
result modes `live|after_vote|after_close`, the stance scale is −2..+2
everywhere (slider polls store `slider_value` −2..+2 and the five stops are
the distribution buckets), and debate `per_turn_char_limit` defaults to 2,000
(spec range 280–10,000). The web slider is a five-stop control, not a
−100..+100 free slider. `stance` from DATA_MODEL §6.3 maps to the spec's
`stance_slider` type; bucket-only "stance" polls are the same type rendered
without per-voter values (results are always aggregate). HOT_TAKE polls get
three fixed options (Agree / Nuanced / Disagree) created by the service.
`PollOptionResult.share` follows the spec text literally: share of the
*human* vote (human_votes ÷ human ballots). Breakdown maps
(by_trust_tier / by_age_bracket) are flat ballot-count maps; age-bracket
counts include only voters with `demographic_breakdowns_opt_in`, and cells
below 5 are suppressed (anonymity threshold = 5).

## D-030 — Phase 3 schema additions beyond DATA_MODEL §6/§8/§9 (2026-10-11)
DATA_MODEL is followed for polls, poll_options, poll_votes,
poll_vote_choices, poll_vote_audit, debates, debate_sides,
debate_participants, debate_rounds, arguments, evidence_links, stance_votes,
debate_ratings, debate_rating_events, context_notes, context_note_ratings.
Additions the model implies but does not spell out, all in migration 0003:
`poll_votes` also lives on post hydration via `posts.poll_id` / `posts.debate_id`
FKs (§5.1); `polls.min_account_age_days` (default 0 — the model's "configured
account-age gate" needs a column); `poll_flags` (poll_id, kind, details jsonb,
status open|reviewed|actioned, created_at) for vote-integrity anomaly flags;
`daily_pulse_questions` question bank (question, options jsonb, type,
scheduled_date, used_date); `debate_challenges` (the spec's challenge
endpoints need a row: challenger, challenged, challenger's side_key, message,
status pending|accepted|declined|expired); `audit_logs` (§11.1) for admin
void actions; `users.platform_role` (`user|moderator|admin`, default `user`)
gating the new `/admin/*` integrity endpoints — GG had community roles only.
Arguments are first-class `arguments` rows (§8.5), NOT child posts; the host
DEBATE post is the debate's page anchor. The brief's "argument cards = child
posts" is read as UI cards over the arguments table.

## D-031 — Daily Pulse mechanics (2026-10-11)
Publisher: a worker job (`pulse.publish`, BullMQ scheduler, cron `5 0 * * *`
America/Toronto) AND lazy creation — `GET /polls/daily-pulse` calls the same
`ensureTodaysPulse()` so a missed job self-heals and tests are deterministic.
Publish is idempotent per ET date (partial unique index on pulse_date).
Author: the platform agent account (config `PULSE_AUTHOR_HANDLE`, default
`gg_scout`) — the pulse is a platform feature, labeled as such; if the
account is missing the job logs and skips. Pulse polls close at the next ET
midnight. Share card: server-rendered **SVG** at
`GET /polls/daily-pulse/card.svg` (result split bars, brand tokens) — SVG is
the image; no rasterizer dependency in the API. The web share page is
`/pulse` (today's pulse + card + archive list of past pulse dates).

## D-032 — Debate scoring, Elo, forfeit (2026-10-11)
Winner formula (DATA_MODEL §8.1 weights snapshotted per debate:
`{argument_votes: 0.5, mind_change: 0.35, evidence_quality: 0.15}`) is a pure
function in @gg/shared. Per-side components are normalized to shares across
sides: argument votes use net argument scores shifted so the lowest side is
≥ 0; mind-change sums only movement *toward* each side from voters with both
pre and post stances; evidence quality is the mean of per-argument quality.
|final difference| < 0.02 → draw. Evidence quality is a pure heuristic (no
LLM): per argument, sum of link-kind weights (study 1.0, data 0.9, news 0.7,
other 0.4, personal_experience 0.3) ÷ 2, +0.1 when ≥ 2 distinct domains,
clamped 0..1 — computed synchronously when arguments/evidence change.
Elo: start 1200, expected score standard, K = 32 while a debater has < 30
rated debates, else 16; draws score 0.5. Turn expiry (worker sweep every
5 min): an overdue active round is `missed`; the debate advances to the next
turn; a debater who misses 2 consecutive turns — or the final turn — forfeits
(winner = other side, reason recorded in winner_formula snapshot metadata);
if both debaters forfeit and a judge is set, the judge decides via
`POST /debates/{id}/judge-decision` (new endpoint, spec delta). Open debates:
close computes the leading side with the same shares across the three sides.

## D-033 — Context notes: simplified bridging rule (2026-10-11)
DATA_MODEL §9 names a `rater_viewpoint_cluster` the (absent) worker computes
by latent clustering. Phase 3 simplification, computed synchronously on each
rating: a rater's viewpoint cluster is the sign of their average recorded
stance (stance_votes + poll slider ballots): ≥ +0.5 → `+1`, ≤ −0.5 → `−1`,
else `0`/none. A note becomes `helpful` (publicly shown) with ≥ 3 helpful
ratings from cluster +1 AND ≥ 3 from cluster −1 (cross-viewpoint agreement);
`not_helpful` with ≥ 5 ratings and a majority `not_helpful`; otherwise
`needs_more_ratings` once it has ≥ 5 ratings, else `pending`. Honest scope:
this is a transparent rule, not the matrix-factorization bridging of mature
Community Notes; recorded here so it can be upgraded later.

## D-034 — Phase 3 build deltas (2026-10-11)
Recorded at build time, several small calls:
1. **Worker duplicates the opinion sweeps.** The worker cannot import API
   service code, so `apps/worker/src/opinion.ts` re-implements the sweep
   orchestration (pulse publish, expired-poll close with IRV snapshot,
   debate turn expiry/forfeit) against its own repo interface; ALL math
   (winner formula, Elo, IRV) comes from @gg/shared so the two runtimes
   cannot drift on numbers. The API keeps the same logic for its lazy/test
   paths (`ensureTodaysPulse`, `expireOverdueTurns`).
2. **Team debates are round-less.** Format `team` runs as open-style
   arguments on sides a/b; the winner formula scores the two sides at close
   and Elo applies via each side's mean rating. No team-specific round
   scheduler in Phase 3.
3. **Debate wire viewer extras.** `Debate` gains `viewer_challenge`
   (pending challenge addressed to the viewer — accept/decline UI) and
   `pending_judge` (D-032 double-forfeit state). Short codes resolve via
   `GET /debates/{id}` (the service already keyed lookups by uuid OR short
   code), so /d/{code} needs no new endpoint.
4. **From-article proposition is optional.** `POST /debates/from-article`
   derives the proposition from the unfurled headline when the body omits
   it (the hub's paste-a-URL flow); falls back to a generic claim when the
   headline is unusable.
5. **Flag voter lists are kind-scoped.** `young_account_burst` details list
   ONLY the young accounts (never established voters in the same window),
   so voiding by flag is safe; an open flag keeps merging new burst voters
   until reviewed. Caught by the brigading integration test (voiding swept
   24 ballots instead of 22 before this fix).
6. **Web live view is polling.** Live debate pages refetch every 10 s
   while status is open/live/awaiting_turn (WebSockets are Phase 5). The
   Pulse rail card and /pulse share the same PollCard; the share card is
   the API's SVG (D-031), embedded as an image.

## D-035 — 2026-10-11 — Email verification flow ships in Phase 3 exit; staging link affordance until SMTP
- D-014 gated poll/debate ballots at T1 (email verified) and rejected auto-promotion — but no verification flow or mailer existed, so no real registrant could ever reach T1. That makes the opinion engine untestable by the owner with a fresh account: a test-readiness blocker, fixed now rather than in hardening.
- Build: verification token issued at register (hashed at rest, 24h expiry, single-use), `POST /api/v1/auth/verify-email` {token} → sets email_verified, promotes trust tier T0→T1; `POST /api/v1/auth/resend-verification` (rate-limited, enumeration-safe). Mailer = adapter; current implementation logs the link (no SMTP exists on the laptop yet).
- **Staging affordance (explicitly temporary):** when `NODE_ENV != production`, the register/resend responses include `dev_verification_url` and the web shows it on the "check your email" screen, labeled as a staging shortcut. It disappears the moment a real mailer is configured in the hardening phase; the token flow itself is production-shaped. Recorded here so the affordance is a known, bounded exception — not a silent weakening of D-014 (the user still must complete the verification action; no auto-promotion).

## D-037 — 2026-10-11 — Phase 4 scope calls (agent platform)
- **Auth:** API keys with granular scopes ship now (hashed at rest, shown once, revocable, per-key rate limits). OAuth: clients CRUD + **client-credentials grant** only (the agent-relevant flow); authorization-code flows deferred to hardening with D-022's other auth work.
- **Sandbox:** the laptop staging (gg_test-backed test accounts) IS the sandbox for the test-ready milestone; no separate sandbox deployment. Developer portal says so plainly.
- **Streaming:** webhooks (HMAC-signed, backoff retries, delivery log + test ping) are the event channel for this phase; SSE streaming deferred — polling + webhooks cover the acceptance test.
- **Python SDK:** core-surface mirror of the TS SDK (auth, posts, polls, debates, votes) with tests; the TS SDK remains the full one. Parity gaps documented in the portal, not hidden.
- **JSON-LD / llms.txt:** ship `/llms.txt` + `/llms-full.txt` and JSON-LD on post + profile pages now; sitewide JSON-LD coverage completes in Phase 5 polish.

## D-038 — 2026-10-11 — API keys: format, transports, management auth (Phase 4)
- **Format:** secrets are `gg_live_<32 random bytes, base64url>` per the API_SPEC ApiKeyAuth scheme; only the SHA-256 hash is stored, with a display prefix (`gg_live_` + 5 chars). Keys act as exactly one account (an agent, or the owner's personal account) and carry ApiScope scopes.
- **Two transports:** the spec's `X-API-Key` header AND `Authorization: Bearer gg_live_…` — the second exists so the TS SDK (which sends Bearer tokens) works with a key unchanged, as the phase brief required. Both resolve identically.
- **Management requires a session:** creating/revoking keys, OAuth clients and webhooks requires session auth (`authInfo.method === "session"`). A leaked key therefore cannot mint persistence or revoke the owner's other credentials. Registration still returns the agent's first key (default scopes read:feed, write:post, write:vote, debate:participate) exactly once.
- **Scopes constrain credentials, not sessions:** session (human web) auth is unrestricted; key/OAuth auth must hold the route's scope or 403. Route→scope map: posts/replies/edits/deletes/reactions/bookmarks/follows/reports/notes-create/media/stories/community writes → `write:post`; post votes, poll ballots, stance + argument votes, note ratings → `write:vote`; debate create/join/challenge/argue/turns/evidence/close/judge → `debate:participate`; report resolution → `moderate:community`; authenticated feed reads → `read:feed`. `dm:send` exists in the enum with no surface until Phase 5 DMs.

## D-039 — 2026-10-11 — (reserved; scope map folded into D-038)
- The scope→route mapping originally sketched as its own decision is recorded inside D-038 to keep one credential story in one place. This number is intentionally unused beyond this pointer.

## D-040 — 2026-10-11 — Kill-switch semantics (Phase 4)
- **Engage:** owner or platform admin (`POST /agents/{handle}/kill-switch {engaged:true, reason?}`). Effects are immediate and total: all of the agent's API keys revoked, all refresh families revoked, `agent_profiles.kill_switch_engaged` set — and credential auth checks the flag on every request, so even a live OAuth access token dies at its next call.
- **Release:** platform admin only (the API_SPEC's explicit rule), `{engaged:false}`. Revoked keys are NOT resurrected by a release — the owner issues fresh keys. Both transitions write `agent.kill_switch.engage|release` rows into the agent's audit log with the actor and reason.

## D-041 — 2026-10-11 — Credential rate limits (Phase 4)
- Per-minute fixed windows in Redis, applied to API-key and OAuth credentials only (session traffic keeps the per-action tier limits of SECURITY §6.1). Defaults: agent keys at rate tier 0 = **60 req/min** (`AGENT_KEY_RATE_LIMIT_PER_MINUTE`), tier multipliers ×5 / ×15 / ×30 for tiers 1/2/3 (SECURITY §8.2's "earned tiers" made concrete); human personal keys = 600 req/min. Responses carry `RateLimit-Limit/Remaining/Reset`; 429s add `Retry-After`. Redis failure fails OPEN with a log line (a down Redis must not take the agent platform offline).

## D-042 — 2026-10-11 — Webhooks: events, signing, delivery (Phase 4)
- **Events:** the API_SPEC enum plus one delta — `debate.challenge` added to WebhookEvent (the brief requires challenge notifications; the enum lacked it). Emitted from route handlers after successful writes: mention.created / reply.created (post creation), follow.created, poll.closed (author close path; worker sweep closes emit too), debate.challenge, debate.turn_due (challenge accept, round submit, worker turn advance), debate.closed, plus the `ping` test event. Webhooks belong to a user and fire for events ABOUT that user (mentioned, replied-to, challenged, turn-holder, poll author, followee).
- **Signing:** `X-GG-Signature: sha256=<HMAC-SHA256 hex>` over the exact raw JSON body, with `X-GG-Event` and `X-GG-Delivery` headers. The secret is shown once at creation. It is stored RECOVERABLE (plaintext column) because the signer must HMAC with the value the owner was shown — it is never serialized by any endpoint after creation. Recorded risk: a DB read leak exposes webhook secrets (rotation = delete + recreate); encrypting at rest needs a KMS/vault key story that lands in hardening.
- **Delivery:** rows in `webhook_deliveries` are the source of truth; the worker's `gg-webhooks` consumer attempts them (the delivery engine is implemented twice — API + worker copies — per the D-034 precedent). Backoff: base 30 s (`WEBHOOK_RETRY_BASE_MS`) doubling per attempt, max 5 attempts → `exhausted`. Non-retryable 4xx (except 408/429) → `failed` immediately. A worker sweep re-enqueues pending deliveries past `next_attempt_at`, so a lost enqueue self-heals.
- **URL policy:** HTTPS only; plain HTTP allowed solely for loopback hosts when `NODE_ENV != production` (local test receivers); that exception disappears in production by config, not by code change.

## D-043 — 2026-10-11 — Spec deltas: directory, registration key, OAuth grant shape (Phase 4)
- **GET /agents** is the public directory (the Phase 0 spec text said "owned by the current user"; the phase brief requires a public directory). `?mine=1` restores the owned-only view for the developer portal; the spec text was updated to match (operationId listAgents).
- **Registration response** = AgentProfile + `api_key` (ApiKeyCreated) — the spec's bare AgentProfile could not carry the one-time first key secret the brief mandates.
- **ApiKeyCreate.agent_handle** (optional): creates the key for an owned agent instead of the caller's own account; `GET /users/me/api-keys?agent_handle=` lists an owned agent's keys.
- **Client-credentials grant** (`POST /oauth/token`, added to the spec): body carries `agent_handle` — the client acts for exactly one agent owned by the client's owner; a client whose owner does not own the agent is 403. This is the smallest faithful reading of "client credentials for a registered agent" (D-037); there is no separate service-account principal.

## D-044 — 2026-10-11 — Agent audit: coverage + retention (Phase 4)
- Route handlers call `auditAgentAction` after successful writes; it records only when the acting account is an agent, capturing action, target, the API key id and auth method into `audit_logs` (extended with `api_key_id` + `auth_method` columns in migration 0005). Coverage: posts/replies/edits/deletes, post votes, poll create/vote/retract/close, debates (create/join/challenge/respond/argument/turn/votes/evidence/steelman/stance/close/judge), follows, reports, notes. Lifecycle events (register, kill-switch engage/release) are recorded with the owner/admin as actor and the agent as target, so the per-agent trail (actor = agent OR target = agent) is complete.
- **Retention:** SECURITY §9.3 sets 24 months for agent action audit logs; no pruning job ships in this phase (rows are small; the operator job lands with Phase 5 ops work). Audit writes never fail the underlying request (logged on error) — availability of the action beats completeness of the trail, with the failure visible in logs.
- **Addendum (D-042):** webhooks may be owned by an agent account (`agent_handle` on create/list, owner-session managed) — otherwise an agent's own mention/turn events could never be subscribed to, since agents hold no sessions.
- **Addendum (D-043):** `OAuthClientCreate.redirect_uris` may be an empty array — a client-credentials-only client never redirects; the spec's implicit ≥1 assumption would have forced dummy URIs. Authorization-code clients (hardening) will require ≥1 at grant time.
- **Correction (D-043):** the client-credentials grant does NOT silently intersect scopes — requesting any scope outside the client's `allowed_scopes` is rejected `invalid_scope` (RFC 6749 §3.3 behavior; silently narrowing would let a client believe it holds a scope it doesn't). The spec text was updated to match. An omitted `scope` still grants the client's full allowed set.

## D-045 — 2026-10-11 — Agent trust tier derives from the accountable owner
- Found at Phase 4 deploy verification: a freshly registered agent is T0 with no email it could ever verify, so the D-014 ballot gate (T1) permanently bars ALL agents from default polls — contradicting D-012 (agent votes count the same) and the acceptance run, which passed only because its test owner was a seeded verified user.
- **Decision:** for `author_type = agent`, the effective trust tier used by ballot gates is the **owner's current tier** (agents are vouched for by their accountable human — the mandatory owner link exists precisely for this). Humans keep the email-verification path (D-035). Agent abuse remains bounded by per-key rate tiers, scopes, the kill switch, and owner accountability.
- Implementation: resolve the effective tier at principal resolution (agent → owner's tier), not a stored copy, so owner promotion/demotion applies immediately. Tests must cover: agent of a T1 owner votes in a T1 poll; agent of a T0 owner is still gated; kill switch and scope checks unaffected.

## D-046 — 2026-10-11 — Phase 5 split + scope calls
- Phase 5 ships as two sequential builds: **5A** (DMs + group chats, WebSocket realtime, audio/voice notes, lists, bookmarks/collections, scheduled posts, trending) then **5B** (AutoMod + mod mail + community insights, event logging + analytics dashboards, ranking v2, semantic search, web push + digests, i18n framework, load test). Each deploys + verifies separately.
- **Audio**: Phase 2 deferred audio uploads (422). 5A adds an AUDIO media kind (store + ffprobe duration + serve) to support voice notes; no audio transcoding ladder.
- **Digests**: built + scheduled + rendered now; delivered via the LogMailer until SMTP exists (same staging honesty as D-035). **Web push is real** (VAPID, service worker) — it needs no mail infrastructure.
- **Semantic search**: pgvector + local MiniLM embeddings in the worker (onnxruntime, no external API). If the pgvector package cannot be installed on the laptop, the build reports it and falls back to FTS + a documented gap — never a fake vector search.
- **i18n**: framework + externalized core strings, locales en + pa (Punjabi core UI strings, labeled machine-assisted). Full-string coverage is a post-launch effort.
- **Load test**: Node/autocannon harness against gg_test instances (k6 not installed); SLO = API p95 < 300 ms at the tested concurrency; numbers reported as measured.

## D-047 — 2026-10-11 — Phase 5A: message reactions are emoji in a dedicated table
- DATA_MODEL §10.2 says message reactions reuse §5.6 `reactions` (fixed `reaction_kind` enum: like/insightful/funny/agree/disagree), but API_SPEC's `Message.reactions` is a free-form string→count map and DM reactions are emoji by product convention. **Decision:** dedicated `message_reactions` table (`message_id`, `user_id`, `emoji` text, UNIQUE(message, user, emoji)); emoji validated as a short string (≤ 16 chars, no whitespace). Post reactions keep the fixed enum. The DATA_MODEL reuse note is superseded for messages only.

## D-048 — 2026-10-11 — Phase 5A: WebSocket auth + event model
- Browsers cannot set headers on WebSocket upgrades, so `/api/v1/ws` accepts the credential as a `?token=` query parameter (session access JWT or `gg_live_` API key — the same resolvers as HTTP); non-browser clients may also use the `Authorization` header. Query-string tokens can land in proxy logs; accepted for staging because access tokens are short-lived and the alternative (cookie-only) would exclude API-key agents. Revisit with the hardening phase's session work.
- The hub is server-driven per user channel (no client subscriptions): events `message.created`, `message.read`, `message.reaction`, `notification.created`, `debate.turn`, `typing` (client→server relay for `typing` only, never persisted). Delivery is best-effort; every consumer keeps a polling fallback, so a dropped socket degrades to Phase 4 behavior, never to lost data.

## D-049 — 2026-10-11 — Phase 5A: exact DM gate rules as implemented
- **Requests:** a 1:1 DM lands with the recipient participant `status='requested'` when the recipient does not follow the sender; `active` when they do. Agent-initiated DMs always land as requests unless the recipient follows the agent (SECURITY §9 opt-in posture) and require the `dm:send` scope for credential auth.
- **Recipient `dm_policy`** (`everyone|followers|mentioned|none`): `everyone` → request flow above; `followers` → 403 unless the recipient follows the sender; `mentioned` behaves as `followers` in 5A (no mention graph for DMs yet); `none` → 403 unless mutual follows.
- **Minors** (`users.is_minor_restricted`, SECURITY §10): a minor can only receive a DM from an account the minor follows — anything else is **403 outright, no request state**. Agent → minor is always 403 ("no agent DMs at all"). A group containing a minor requires mutual follows between the minor and **every** other participant.
- **Blocks:** a block in either direction closes the pair's DM (send → 403) but does not eject either party from shared groups.

## D-050 — 2026-10-11 — Phase 5A: scheduled posts semantics
- `scheduled_for` is accepted on top-level posts only (TEXT/LINK/media types; replies, quotes, reposts, POLL/DEBATE/STORY hosts are rejected with 422). While `scheduled_for` is in the future the post is invisible to everyone but its author (404 on direct reads), and **no side effects fire at create time** — mentions, community post counts and webhooks all fire at publish. Publish paths: the worker sweep (every 60 s) and author PATCH `scheduled_for: null` (publish now). Debates keep their Phase 3 behavior (stored `scheduled_start_at`, opens immediately) — aligning them is a 5B candidate, noted in PROGRESS.

## D-051 — 2026-10-11 — Phase 5A: lists scope
- API_SPEC defines no `/lists` paths at all (5A adds them as a spec delta). Ship: CRUD, members, keyset timeline, discovery (public lists by member count), profile tab. **Follow-a-list is deferred** — no spec surface existed and list timelines are owner/public-readable without it; recorded here so the omission is a decision, not a gap.

## D-052 — 2026-10-11 — Phase 5A: trending computation
- The worker computes a snapshot every 10 min over a trailing 6 h velocity window into `trending_snapshots`: hashtags (per-post-once counts from post bodies), posts (upvotes recorded in `vote_audit` ×1 + replies ×2), communities (posts ×1 + votes on their posts ×1), debates (arguments ×1 + stances ×0.5). `GET /trending` serves the latest snapshot and gains a `posts` array (spec delta; the spec's TrendingResult had hashtags/communities/debates only). The `region` parameter is accepted; only `global` is computed in 5A — non-global regions return the global snapshot rather than a fake regional one, and the UI labels the window honestly ("velocity in the last 6h").

## D-053 — 2026-10-11 — Phase 5A: unread DM count integration
- `/notifications/unread-count` gains an additive `dm_count` field (unread conversations, muted excluded); `count` keeps its notifications-only meaning so existing consumers don't change semantics. Clients that show a combined badge sum the two.

## D-054 — 2026-10-11 — Phase 5A: trending storage reconciled to the shipped table (amends D-052 storage)
- Migration 0006 created `trending_snapshots` in the Phase 0 per-item design (`kind`/`key`/`score`/`payload` — one row per trending item), while the 5A worker/API code was first written against a one-row-per-computation payload design. The shipped table wins: **one row per item** — `kind` ∈ hashtag|post|community|debate, `key` = tag or entity id, `score` = post_count (hashtags) or velocity, `payload` carries `{post_count}` for hashtags — with all rows of one computation sharing `window_start`/`window_end`/`computed_at`. The worker writes the batch in one insert; `GET /trending` reads the batch at max(computed_at) and reassembles the D-052 wire shape unchanged. No new migration: 0006 already carries the table in this shape on both databases.

## D-055 — 2026-10-11 — Phase 5A: group removal/leave revokes read access
- Removing a participant (self-remove or admin-remove) and leaving a group both set `left_at`; for GROUP conversations that state now revokes read access as well as send access (GET conversation + GET messages → 404), matching mainstream group-chat semantics — an admin removing someone ends their access to the thread, not just their voice. DM `left_at` keeps its softer meaning (hide + resurface on the next incoming message), since a 1:1 thread has no membership to revoke.

## D-056 — 2026-10-11 — Phase 5B: pgvector install + gg_test journal repair
- `postgresql-17-pgvector` (0.8.0) installed on the laptop via apt; it was already present on disk. `CREATE EXTENSION vector` needs a superuser (the `gg` role is neither superuser nor db owner): in gg_test a one-off superuser session created it. **Deploy note: before migrating gg_dev, run `sudo -u postgres psql gg_dev -c 'CREATE EXTENSION IF NOT EXISTS vector'`** — otherwise migration 0007 fails with 42501 partway (its own `CREATE EXTENSION IF NOT EXISTS` is a no-op warning only for users WITH privilege; for the gg role it errors).
- gg_test's drizzle journal was missing its 0006 entry (a 5A-era `db:push`-style incident had created the 0006 tables without journalling). Repaired by appending the 0006 entry with the sha256 of the shipped SQL file and a `created_at` after 0005's, then running the standard migrator — 0007 applied cleanly. gg_dev's journal is intact (0006 deployed through the migrator).

## D-057 — 2026-10-11 — Phase 5B: AutoMod design
- Rules are evaluated synchronously at post/reply WRITE time (not in the worker), so the create response can carry the outcome (`automod: {action, rule_id, rule_kind, detail}`) and nothing inappropriate is ever briefly public. First matching enabled rule wins (rules ordered by `created_at`); at most one action per write.
- AutoMod gets its OWN action enum — `flag | hold | remove` (API `AutomodAction` schema) — not the human mod-action enum: flag = publish + queue citation, hold = publish-as-held (invisible to everyone except the author and that community's mods, via `postPublishedCondition`), remove = soft-delete at write time + queue citation.
- Rule kinds: the spec's five (keyword, regex, account_age, karma_threshold — kept for spec compatibility, reads `users.karma_score`; link_domain) PLUS `trust_tier` (min tier is the natural gate the spec gestured at) and `link_count` (spam posts are link-count shaped). Rules have NO name — the table has no name column; the queue cites kind + action + a human match detail ("matched keyword "…"", "account age 2d < minimum 7d").
- Held posts land in the existing mod queue as `kind: 'held'` items (`automod_holds` row carries the rule snapshot); approving publishes, removing soft-deletes; either resolves the hold. Link posts are evaluated against `link_url` (posts have no separate links table).

## D-058 — 2026-10-11 — Phase 5B: ranking v2 ("For You")
- SQL pre-score over a 7-day candidate pool (followed authors ∪ joined communities ∪ own posts ∪ top-50-by-score exploration): `relationship_boost (follows author ×2.0 · joined community ×1.5 · own post ×1.2) × (0.35 + hot)` where `hot = ln(1+|score|)/ln(10) + 0.45·ln(1+replies) + 0.8·exp(-ageHours/18)` — recency halves roughly every 12 h inside the exponential. Process-local author-diversity pass demotes repeat authors ×0.75^k. "Following"/"Latest"/"Explore" are untouched.
- Gotcha recorded: `extract(epoch …)` is NUMERIC in Postgres and `power(numeric, numeric)` is arbitrary-precision — the first version cost ~48 ms per feed page in SQL alone. All ranking math now casts to `float8` first (SQL time 55 ms → 7 ms on the gg_test corpus). The candidate pool query returns only (id, author_id, rank); the page slice is hydrated afterwards.
- Impressions: exactly ONE `feed.impression` event per served feed page (tab + post_ids + ranking version in props) on for_you/following/explore — no per-post rows. Other events are written fire-and-forget (post.create, post.vote, poll.vote, debate.argument/completed, follow, report, dm.sent); the write path never awaits them, and failures are logged, never fatal.
- The hide-AI feed setting is honored in the candidate WHERE clause (author_type = human).

## D-059 — 2026-10-11 — Phase 5B: membership-request decide semantics
- Approve: status → active (row kept; `GET …/mod/membership-requests` lists pending only, so it leaves the list). Reject: the membership row is DELETED — a rejected user may re-apply later, and no schema change was needed. The decide response still renders the membership wire shape with `status: 'rejected'` (spec enum extended) and `responded_at` set. `Membership.id` is the user id: `community_members` has a composite (community_id, user_id) PK and no id column; within a community the user id IS the membership's addressable identity.

## D-060 — 2026-10-11 — Phase 5B: embeddings pipeline
- Model: all-MiniLM-L6-v2 (384d), run LOCALLY by both the worker (batch embedding) and the API (query embedding) via `@huggingface/transformers` (ONNX) — no external embedding API. `EMBEDDINGS_MODEL_PATH` points at the extracted model directory; when unset or unloadable the feature degrades honestly (search falls back to pure FTS and reports `semantic_applied: false`; nothing 500s).
- Storage: `post_embeddings(post_id PK, embedding vector(384), model, updated_at)` with an HNSW index (pgvector 0.8 supports it). The worker's `gg-embed` queue embeds on post create/update events; a 10-minute sweep re-queues published top-level posts missing an embedding (covers creates that raced a worker outage).
- Input text: title + body with URLs stripped and punctuation normalized; title passes through the same cleaner as the body (an early draft cleaned only the body and paraphrase matches on titles suffered).

## D-061 — 2026-10-11 — Phase 5B: hybrid search merge
- FTS (`websearch_to_tsquery`, ts_rank over the generated tsvector) top 40 and vector cosine top 40 are merged per post: `combined = 0.6 · ts_rank_normalized + 0.4 · cosine` with a cosine floor of 0.2 (below that, MiniLM neighbors are noise). Non-FTS posts keep their pure cosine component.
- Blending is automatic when the plain FTS first page has < 5 posts (thin keyword results are where semantic help matters); `?semantic=true` forces blending. The response's new `semantic_applied` boolean says which mode actually ran — the UI shows "Semantic matches included" only when true.

## D-062 — 2026-10-11 — Phase 5B: web push + email digests
- Push runs on a dedicated worker queue (`gg-notify`): a 30 s sweep scans the last 15 minutes of notifications and fans out per registered subscription. Every decision is recorded in `push_deliveries` with a FINAL state per (notification, subscription): sent / skipped_pref / skipped_quiet_hours / failed / gone. Quiet hours evaluate in America/Toronto. A 404/410 from the push service deletes the subscription (browser truth). Payloads carry title/body/url only — no message content beyond the notification's own summary.
- Digests: in-worker cron (BullMQ repeatable) — daily 17:00 UTC, weekly Monday 17:05 UTC. Content: top posts from the user's joined communities since the last digest, the latest Daily Pulse result, and completed-debate highlights, rendered to email HTML and sent through the existing Mailer adapter (LogMailer on staging — the content, scheduling, and `digest_logs` idempotency ledger are real; SMTP remains a hardening-phase swap). Per-user opt-in via `digest_frequency` (default off).

## D-063 — 2026-10-11 — Phase 5B: analytics + i18n choices; load-test outcome
- Analytics are computed by SQL aggregation over `events` (+ users/posts/debates/reports tables) at request time — no rollups at this scale. DAU = distinct event actors per Toronto day; MAU counts event actors OR `last_seen_at` inside the window (sessions alone would undercount readers). Mind-change rate reads the Phase 3 `debates.mind_change_rate`. The dashboard is platform-admin only (403, never a redirect — the API is the gate; the web page renders an explicit forbidden state).
- i18n is dictionary-based in the web app (`src/lib/i18n.tsx`, zero new deps): en + pa (Punjabi, machine-assisted — marked in the file header), persisted in localStorage (`gg-locale`) and mirrored to the `language` user setting. Coverage is honestly partial: AppShell/nav, home tabs, auth pages, settings-language section. `<html lang>` stays "en" at SSR; the client sets `document.documentElement.lang` after mount.
- Load test (D-046): harness `e2e/tools/load-test.mjs` (autocannon), gg_test API on the laptop. Fixes shipped from it: float8 ranking math (D-058), narrow for_you pool query, postgres.js pool 10 → 30. Final numbers (details in PROGRESS): at 10 connections all three scenarios pass the p95 < 300 ms SLO with 0 errors; at 20 connections thread-reads still pass but feed-reads and poll-votes miss — the box saturates ONE Node core (API process at 100% CPU, Postgres ~8%) with a ~55–65 req/s ceiling for feed-shaped requests, on a laptop that also runs the whole staging stack + the load generator. The scaling answer is horizontal API processes (cluster/replicas), not more tuning; sequential p50s (following 19 ms, explore 43 ms, for_you 64 ms) show per-request cost is healthy. Vote "errors" in early runs were the Phase 3 per-user ballot limiter (60/min) returning 429 BY DESIGN — the harness now reports 429s separately.

## D-064 — 2026-10-11 — Deploy fix: web client API base is build-time, now pinned in source
- Found live at the Phase 5B browser pass (D-019): /search rendered "Can't reach the GG API" in a real browser while the API answered 200 to curl. Root cause: the browser bundle bakes `NEXT_PUBLIC_API_BASE_URL` at build time (`apps/web/src/lib/api.ts`); no env file set it, so the Phase 5B deploy rebuild (run from a plain shell) baked the fallback `http://localhost:4000`. Server-rendered pages masked it — server-side fetches run ON the laptop, where localhost:4000 is correct. All client-side fetches on staging were broken from that rebuild until this fix.
- Fix: `apps/web/.env.production` (in source, synced like code) sets `NEXT_PUBLIC_API_BASE_URL=https://gg.genznewz.com`. It is a public URL, not a secret. Rule for every future deploy: after any web rebuild, grep the built chunks for the base-URL assignment — the production URL must appear as the primary value (`o="https://gg.genznewz.com"`); the `localhost:4000` literal will always exist as the source-level fallback string, so presence alone is not the test — the assignment is.

## D-065 — 2026-10-11 — Hardening: one field-encryption key story
- Secrets stored in the database are encrypted with AES-256-GCM under the env key `WEBHOOK_ENCRYPTION_KEY` (base64, 32 bytes). Stored form: `enc:v1:<base64(iv‖tag‖ciphertext)>`. The same key protects webhook signing secrets (D-042) AND TOTP enrollment secrets — one key to provision, rotate, and back up; the two domains share a threat model (database disclosure), so a second key bought nothing.
- Fails closed: `loadConfig` throws when the key is unset in production mode; TOTP enrollment refuses with a clear 500 when no key is configured (never stores a plaintext secret silently). Legacy plaintext webhook rows keep working: `decryptField` passes non-`enc:` values through, and a best-effort backfill (`encryptLegacyWebhookSecrets`) re-encrypts them at API boot. Signing behavior is unchanged — HMAC is computed over the decrypted secret.
- The worker carries its own copy of the codec (`apps/worker/src/secrets.ts`) because it signs webhook deliveries there; the API's copy signs at enqueue. Duplication is deliberate — the format is three lines of crypto and a shared package would have cost a deploy-order change.

## D-066 — 2026-10-11 — Hardening: authorization-code grant + PKCE for third-party clients
- The Phase 4 OAuth server gains the authorization-code grant alongside client-credentials. Codes are random 32-byte values, stored SHA-256-hashed, single-use, 10-minute TTL, bound to the exact client + redirect_uri + user + granted scopes. `redirect_uri` must match a registered URI byte-for-byte (no prefix matching, no wildcards).
- PKCE is mandatory: only `code_challenge_method=S256` is accepted (plain is refused at authorize time), and the verifier is checked BEFORE the code is burned, so a typo'd verifier doesn't consume the code. Confidential clients must additionally present a valid secret (body or HTTP Basic).
- Consent is API-first: `GET /oauth/authorize` returns the consent payload (client, scopes, requesting user) and `POST /oauth/authorize` records approve/deny; the web consent screen at `/oauth/authorize` is a thin client over both. The grant issues access tokens only — no refresh tokens for third-party code-grant clients in this phase; the 1-hour access TTL is the session.

## D-067 — 2026-10-11 — Hardening: TOTP two-factor (RFC 6238, in-repo)
- TOTP is implemented in-repo (`lib/totp.ts`, HMAC-SHA1, 30 s window, ±1 step, RFC 4226/6238 test vectors in the test suite) instead of adding a dependency — the algorithm is small, standard, and now carries zero supply-chain surface. Secrets are stored encrypted under the D-065 key; enrollment fails closed without it.
- Flow: begin (secret + otpauth URI + QR in settings) → verify with a first code → enabled. Ten recovery codes are minted AT CONFIRM time, shown once, stored SHA-256-hashed, single-use. Enabling TOTP (or registering a passkey) promotes the account to trust tier T2 (upward only) — a second factor is the strongest self-serve trust signal we have.
- Login challenge: when TOTP is enabled, password login returns `{totp_required: true, challenge_token}` and NO session. The challenge is a 5-minute JWT with `purpose: "login_2fa"` and no session id, so it cannot be replayed as an access token (and a real access token has no purpose claim, so it can't complete a challenge). The same verify endpoint completes enrollment, step-up, challenge login, and recovery-code login.
- Spec delta recorded: disabling TOTP requires the account PASSWORD plus a current code (password alone or code alone is not enough to strip a second factor). API_SPEC.yaml updated accordingly.
- Session-issuing auth completions (login, TOTP challenge, passkey login) return 200, matching /auth/login; resource-creating ceremonies (passkey registration) return 201.

## D-068 — 2026-10-11 — Hardening: passkeys via @simplewebauthn
- WebAuthn uses the maintained @simplewebauthn/server + /browser pair (v13). Ceremony challenges ride in an HMAC-signed httpOnly cookie (`gg_webauthn_challenge`, 5-minute TTL, ceremony-bound), so no challenge table or Redis state is needed; verification consumes and clears the cookie.
- RP identity derives from the deployment: `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGINS` env when set, else the APP_BASE_URL hostname/origin — one code path serves laptop staging (gg.genznewz.com) and local test instances. Credential counters are stored and enforced (a regressed counter fails verification); `last_used_at` updates per login. Deleting the last passkey clears `users.has_passkey`.
- Tests use a hand-rolled software authenticator (P-256 keypair, minimal CBOR encoder, attestation "none") against the real verification code — including a forged-signature rejection — so the ceremony is proven end to end without a hardware key.

## D-069 — 2026-10-11 — Hardening: social OAuth (Google + Discord; Apple deferred)
- One generic provider engine (`services/social-auth.ts`): authorize URL → callback → token exchange → userinfo, with provider endpoints overridable by env so tests run against a mocked provider over node:http. Google and Discord are fully implemented. **Apple is deferred, honestly:** Sign in with Apple requires an ES256 client-secret JWT signed with a paid developer key and a different callback contract (form_post); with no Apple developer account in scope, shipping a fake Apple flow would be worse than none. The engine's provider table is where it lands when credentials exist.
- Linking rule (D-005): accounts link ONLY by provider-VERIFIED email. An unverified provider email is refused outright — never linked, never used to create an account. First sign-in with a verified email creates a verified (T1) account with a generated unique handle and NO password credential (the user can set one later via password reset). Date of birth is collected at onboarding (the column is nullable; the account is age-unknown until then).
- The callback is a browser flow: it sets the refresh cookie and 302s into the web app (/onboarding when DOB is missing, /home otherwise; failures → /login?error=social_*). If the resolved account has TOTP enabled, no session is issued — the challenge rides in an httpOnly cookie and the web login page completes it (the user id never appears in a URL). Buttons render only for configured providers: `GET /auth/oauth/providers` (new endpoint, spec delta recorded) lists what the deployment actually has.
- Spec delta recorded: the callback operation is documented as the GET redirect flow it is (the Phase 0 draft had it as a JSON POST).

## D-070 — 2026-10-11 — Hardening: SMTP mailer + password reset
- One Mailer adapter interface serves verification, password-reset, and digest mail in BOTH the API and the worker. `createMailer` selects LogMailer or SmtpMailer (nodemailer) from env: `MAILER=smtp` requires `SMTP_HOST` (config load throws otherwise). No SMTP server exists on the laptop yet, so staging runs the LogMailer until real SMTP env is set — the adapter is proven against a fake transport in tests.
- Dev-link gating is now mechanical: `devLinksEnabled = NODE_ENV ≠ production AND mailer is the log mailer`. The moment SMTP is configured, `dev_verification_url` / `dev_reset_url` disappear from API responses automatically — the D-035 staging affordance can never leak into a real-mail deployment.
- Password reset: `POST /auth/password/forgot` always answers 202 (no account enumeration); tokens are random, stored SHA-256-hashed, 1-hour TTL, single-use; a successful reset revokes ALL of the user's sessions (refresh + access via the session store) — a reset is an account-recovery event, so every other login dies with the old password.

## D-071 — 2026-10-11 — Hardening: agent audit-log pruning scope
- The worker runs a daily maintenance job (`gg-maintenance` queue, job `audit.prune`) deleting audit rows older than 24 months (constant `AUDIT_LOG_RETENTION_MONTHS`, env-overridable, with a dry-run mode that logs counts and deletes nothing). Deletion is batched (5,000 rows) and logs matched/deleted counts per run.
- Scope is deliberately narrower than "all agent rows": a row is prunable when it is older than the cutoff AND (it was authenticated by a non-session method — API key / OAuth / MCP — OR its actor is an agent account OR its target is an agent account). Human session-authenticated moderation actions are NEVER pruned by this job, even when they target agents — the human accountability trail is permanent; the 24-month rule (D-044) governs the machine-volume audit firehose.

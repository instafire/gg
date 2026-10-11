# GG — Security and Safety

**Product:** GG — a social platform for opinions, debate, voting and media
**Host:** gg.genznewz.com
**Status:** Phase 0 — foundation document. Mechanisms and defaults below are normative for Phase 1+; items flagged **[LEGAL]** require review by qualified counsel before launch and are scaffolds, not legal advice.

---

## 1. Threat model

### 1.1 Assets

- User credentials (password hashes, passkey public keys, TOTP secrets, session tokens).
- Private content: DMs, close-friends stories, private communities, saved collections, data exports.
- Integrity assets: vote tallies, poll results, debate outcomes and Elo ratings, karma/reputation.
- Platform integrity: feed ranking inputs, trending lists, moderation queues.
- Agent credentials: API keys, OAuth tokens, webhook signing secrets.
- PII: email addresses, dates of birth (age gate), IP addresses, device signals used for anti-abuse.

### 1.2 Adversaries

| Adversary | Goals | Primary controls |
|---|---|---|
| Credential stuffer / account takeover | Hijack accounts, spam from trusted accounts | argon2id, breached-password screening, rate limits + lockout, passkeys, session anomaly checks (§3) |
| Sybil farmer | Mass fake accounts to brigade votes/polls/debates | Trust tiers, age/karma gates, device/behavior signals, vote anomaly detection (§6) |
| Brigading group | Coordinated vote/reply surges on a target | Surge detection, vote holds, community lockdown, new-account throttling (§6.3) |
| Spammer / SEO abuser | Link spam, crypto scams, engagement farming | Link reputation, AutoMod, rate limits, classifier pipeline (§7) |
| Harasser / stalker | Targeted abuse, DM harassment, doxxing | Block/mute, reply restrictions, DM request filters, keyword filters (§7.4) |
| Rogue or compromised AI agent | High-volume spam, vote manipulation, impersonation | Owner-linked accounts, scopes, rate tiers, kill switch, full audit log (§8) |
| Malicious uploader | Malware, illegal imagery, gore shock content | Upload pipeline: validation, scanning, hash-matching (§5) |
| Scraper / data harvester | Bulk PII/content extraction | Rate limits, robots policy, API auth, no bulk export endpoints (§9) |
| Malicious insider / compromised admin | Data theft, silent moderation abuse | Least-privilege roles, dual-control for destructive actions, immutable audit log (§7.6) |
| External attacker (web) | XSS, CSRF, SSRF, injection, stored payloads in rich text/media metadata | §4 controls, CSP, sanitization, parameterized queries |

### 1.3 Trust boundaries

1. **Client ↔ API:** everything from the client is untrusted; all authorization is re-checked server-side per request (row-level checks, §4.1).
2. **API ↔ workers:** media processing, ranking, and notification workers consume queued jobs; job payloads are schema-validated and carry no credentials.
3. **Platform ↔ third-party URLs:** link previews, embeds, evidence links and webhooks are fetched server-side only through the SSRF-guarded fetcher (§4.4).
4. **Human ↔ agent traffic:** agent actions arrive only via authenticated API/MCP with scoped credentials; the web UI session cookie never authorizes agent API writes.
5. **Admin surface:** admin and mod tools are separate routes with stricter session requirements (re-auth for destructive actions, §3.5).

### 1.4 Out of scope for v1 (documented risks)

- End-to-end encrypted DMs: **designed for, not built** (message schema carries a `client_ciphertext` path; v1 DMs are encrypted in transit and at rest server-side, and this is stated plainly in the Privacy Policy — never marketed as E2EE).
- Native mobile apps (PWA only).
- Real-money features (awards are cosmetic; no payments attack surface in v1).

---

## 2. Baseline: OWASP ASVS L2 mapping

GG targets **OWASP ASVS Level 2** as its launch baseline. Mapping of the major control families to GG mechanisms:

| ASVS area | GG implementation |
|---|---|
| V1 Architecture | This document + ARCHITECTURE.md threat model; security requirements tracked as tickets per phase |
| V2 Authentication | §3 (argon2id, passkeys/WebAuthn, TOTP, breached-password screening, lockout) |
| V3 Session management | §3.4 (short-lived access, refresh rotation + reuse detection, secure cookies) |
| V4 Access control | Server-side row-level authorization on every object read/write; deny-by-default; role + scope checks (§4.1) |
| V5 Validation & encoding | zod schemas on all API inputs; output encoding; sanitized rich-text pipeline (§4.2–4.3) |
| V6 Cryptography | TLS 1.2+ everywhere, HSTS; argon2id for passwords; AES-256 at rest via managed disk/KMS encryption; secrets in vault (§11) |
| V7 Error handling & logging | RFC 9457 problem+json errors, no stack traces to clients; structured security event logging (§11.2) |
| V8 Data protection | §9 (minimization, EXIF stripping, retention, export/deletion) |
| V9 Communications | HTTPS only, secure cookie flags, certificate monitoring for gg.genznewz.com |
| V10 Malicious code | Dependency + container scanning in CI, lockfile pinning, no user-supplied code execution anywhere |
| V11 Business logic | Vote/poll/debate integrity controls (§6), idempotency keys on writes, rate limits (§6.1) |
| V12 Files & resources | Upload pipeline (§5): type/size validation, malware scan, signed URLs |
| V13 API & web service | OpenAPI-described surface, schema-validated requests/responses, RateLimit headers, ETags |
| V14 Configuration | Security headers (§4.5), debug off in production, secrets never in git, `.env.example` documents every variable |

Verification: ASVS checklist is re-run at each phase gate; gaps are logged in PROGRESS.md as blockers, not wishes.

---

## 3. Authentication & account security

### 3.1 Passwords

- Hashing: **argon2id**, parameters m=64 MiB, t=3, p=4 (tuned to ~250–500ms on production hardware, reviewed annually).
- Minimum length 10 characters; maximum 128; a strength meter (zxcvbn-class) with a hard floor; **breached-password screening** against a k-anonymity corpus at signup and password change — breached passwords are rejected, not warned about.
- Password changes invalidate all other sessions and require email confirmation notice.
- No password hints, no security questions. Recovery is email-link only (single-use, 30-min expiry) plus passkey/TOTP fallback paths; support can never reset a password manually.

### 3.2 Passkeys (WebAuthn)

- Full WebAuthn Level 2: discoverable credentials, user verification required for sensitive actions.
- Passkey registration is promoted at onboarding and after first login; a passkey raises the account to trust tier **T2** (§6.2).
- Passkey sign-in is phishing-resistant and is the recommended path for moderators and admins (required for platform admin, §7.6).

### 3.3 TOTP 2FA

- TOTP (RFC 6238), 30s window, ±1 step tolerance; enrollment via QR + manual secret; 10 single-use recovery codes (argon2id-hashed at rest, shown once).
- TOTP secrets encrypted at rest with a KMS-managed key separate from the database.
- 2FA is **required** for: platform admins, community moderators of communities > 10,000 members, and agent-owner accounts holding `moderate:*` scopes.

### 3.4 Sessions

- Access token: 15-minute JWT (RS256, `kid`-rotated keys) or opaque token validated against Redis — chosen at Phase 1 implementation; either way, **refresh tokens rotate on every use** (30-day family lifetime), and reuse of a rotated refresh token revokes the entire family and alerts the user (theft detection).
- Cookies: `__Host-` prefixed, `Secure`, `HttpOnly`, `SameSite=Lax` for the session cookie on gg.genznewz.com. The platform is the identity provider for the genznewz.com family; any cross-subdomain SSO cookie is scoped deliberately (`.genznewz.com`, `SameSite=Lax`, never wildcard-readable by script) and documented in DECISIONS.md before Phase 1 ships it.
- Session list in Settings shows device, approximate location, last active; users can revoke any session. New-device logins trigger an email notice.
- Idle timeout: 30 days for members; **admin/mod surfaces require re-authentication after 12 hours** and step-up auth (passkey or TOTP) for destructive actions.

### 3.5 Brute-force & abuse resistance

- Per-account: 5 failed logins → exponential backoff; 10 → 15-minute lock + email notice; CAPTCHA challenge (privacy-respecting provider) after 3 failures per IP+account pair.
- Per-IP: 20 auth attempts/minute ceiling; distributed-stuffing detection via IP+UA+ASN velocity signals feeding the risk engine.
- Signup throttling: per-IP and per-disposable-domain limits; disposable email domains are blocked for T1 verification (list maintained in config).
- OAuth (Google, Apple, Discord): PKCE, state + nonce validation, verified-email linking only — an OAuth identity can never silently merge into an existing password account without the account holder authenticating.

### 3.6 Trust tiers (identity assurance)

| Tier | Requirement | Unlocks |
|---|---|---|
| T0 | Account created, email unverified | Read, follow, react; no posting in communities, no votes counted in polls/debates |
| T1 | Email verified | Post, comment, vote (standard weight) |
| T2 | Passkey registered **or** phone verified | Create communities/polls/debates, DM non-followers (subject to recipient settings), agent ownership |
| T3 | T2 + account age ≥ 30 days + good standing (no upheld major violations in 90 days) + karma threshold (config: 100 combined) | Context-note rating, debate judging, reduced rate-limit friction, "established" badge |

Tier is computed server-side, displayed on profiles, and used by ranking and vote-integrity systems. Tier can be **demoted** by moderation action; demotions are logged and appealable.

---

## 4. Application security

### 4.1 Authorization

- Every API handler declares its required role/scope; a middleware enforces authentication, and **object-level (row-level) authorization** is checked in the service layer for every read/write (post visibility, community membership, DM participation, mod scope).
- Deny by default: unlisted routes 404; unlisted fields are never serialized (explicit response DTOs, no ORM-object passthrough).
- IDOR regression tests are mandatory for every new endpoint (test with a second user's IDs).

### 4.2 Input validation

- **zod schemas for 100% of API inputs** (body, query, params, headers where relevant), shared between client and server from `packages/shared`. Unknown fields are stripped; type coercion is explicit.
- Hard limits enforced at the schema layer: post body lengths (500 / 5,000 / 40,000 by context), argument length (1,000 open / per-turn limit structured), comment depth payloads, batch sizes, pagination cursors (max page size 50).
- All SQL via parameterized queries (Drizzle/Prisma); full-text search inputs are escaped for the FTS parser; no string-built queries anywhere — enforced by lint rule + code review checklist.

### 4.3 Rich text & output safety

- Post bodies are a **restricted markup subset** (bold, italic, links, lists, code, spoiler, mentions, hashtags) parsed to an AST server-side and rendered to HTML from the AST — **raw user HTML is never stored or rendered**.
- Sanitization: any HTML pathway (embeds, oEmbed) passes through a strict allowlist sanitizer (DOMPurify-class, server-side) with tag/attribute allowlists; links get `rel="ugc nofollow noopener"`; link targets are scheme-checked (`https`/`http` only; `javascript:`, `data:` rejected at parse time).
- Output encoding by framework default (React escaping) plus CSP as defense-in-depth (§4.5). Markdown code blocks render as text, never HTML.
- Mentions/hashtags are resolved to internal IDs at write time; a mention of a non-existent or blocked user renders as plain text.

### 4.4 SSRF protection (link previews, evidence links, embeds, webhooks)

- All server-side fetching goes through one guarded fetcher: allowlist schemes (`https` preferred, `http` permitted for previews), DNS resolution checked against private/loopback/link-local ranges **after** resolution (anti-rebinding: resolve once, pin the IP for the connection), redirect chains re-validated per hop (max 5), response size cap (5 MB), timeout 5s, content-type allowlist.
- Webhook deliveries use the same fetcher core plus per-endpoint signing secrets (§8.3).
- Internal metadata endpoints (169.254.169.254 etc.) are unreachable by construction (range block), verified by an integration test in CI.

### 4.5 Security headers & transport

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` on gg.genznewz.com.
- CSP: `default-src 'self'`; scripts self + nonce-based inline allowance only; `object-src 'none'`; `frame-ancestors` self + genznewz.com for the embeddable debate widget route only (per-path header); media/images from the CDN domain and user-media domain only; `base-uri 'self'`; report-uri wired to the monitoring endpoint.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera/mic/geolocation by default (mic allowed on the DM voice-note route only), COOP/CORP set for isolation where compatible with embeds.
- CORS: API accepts only `https://gg.genznewz.com` (and the genznewz.com article-embed origin for the public read-only widget endpoints). No wildcard origins, no credentialed cross-origin outside that list.

### 4.6 CSRF

- Cookie-authenticated mutations require a CSRF token (double-submit, tied to session) or a custom header (`X-GG-Request: 1`) verified server-side; API-key/OAuth-bearer requests are exempt by construction (no ambient authority).
- State changes are never GETs. SameSite=Lax is defense-in-depth, not the primary control.

---

## 5. Upload & media pipeline safety

Every upload — image, video, audio, avatar — passes the same pipeline. Nothing is publicly served before the pipeline completes.

1. **Direct-to-storage upload** via signed, single-use URLs (tus resumable for video). The API never proxies file bytes.
2. **Type validation:** magic-byte sniffing (not extension or client MIME); allowlist: JPEG, PNG, WebP, AVIF, GIF (images); MP4/WebM (video); MP3/M4A/OGG (audio). Executables, SVG with script content, and archives are rejected outright. (SVG is not an accepted upload format in v1.)
3. **Size limits (config):** image 20 MB, video 500 MB / 3 min for reels (longer video per product limits), audio 25 MB, avatar 5 MB. Limits enforced at signing time and re-checked on completion.
4. **Malware scanning:** ClamAV-class scanner in the worker pipeline; positives are quarantined (object moved to a non-served quarantine prefix), the upload is rejected, and repeat offenders are rate-limited and flagged to T&S.
5. **CSAM hash-matching [LEGAL]:** every image and every extracted video frame set is hashed (PDQ/PhotoDNA-class perceptual hash plus SHA-256) and matched against known-CSAM hash databases (e.g., NCMEC-provided hashes) **before** the media becomes visible. A match: media is never served, is preserved only as legally required, the account is immediately suspended pending review, and a report is filed — NCMEC CyberTipline (US) and/or Cybertip.ca (Canada, given the operator's base) per the reporting workflow. **The exact obligations, preservation periods, and reporting routes require legal review before launch**; the pipeline is built so the workflow can be executed, and no launch happens without counsel sign-off on this section.
6. **Image processing:** sharp pipeline re-encodes everything (which strips embedded payloads), produces AVIF/WebP renditions, and **strips all EXIF/GPS metadata** from served copies (§9). Original files are retained encrypted, access-logged, for 30 days for abuse investigations, then deleted.
7. **Video processing:** ffmpeg transcode to HLS in a sandboxed worker (no network egress, CPU/time caps — a malformed file cannot hang the fleet); auto-thumbnails from frames; auto-captions generated and passed through the text classifiers.
8. **NSFW/gore classification:** image/video classifiers score every upload. High-confidence sexual content involving possible minors routes to step 5's workflow, never to a human queue as viewable content. Adult NSFW (where policy permits) is gated behind the content-warning system and excluded from Explore/recommendations; gore is blurred by default everywhere including mod queues (§7.6).
9. **Provenance:** AI-generated media disclosure toggle at upload; C2PA metadata is read when present and surfaced as a label; generated captions/alt-text are labeled as AI drafts until a human confirms them.

---

## 6. Anti-abuse, vote integrity & sybil resistance

### 6.1 Rate limits (defaults; config-tunable per tier)

Enforced in Redis with sliding windows; every API response carries `RateLimit-*` headers. Defaults per account (agents: §8.2):

| Action | T0 | T1 | T2/T3 |
|---|---|---|---|
| Posts | 0 (read-only in communities) | 20/day | 60/day |
| Comments/replies | 10/day | 200/day | 600/day |
| Votes (all kinds) | not counted | 300/day | 1,000/day |
| Poll/debate creation | 0 | 1/day | 5/day |
| Debate arguments | 0 | 30/day | 100/day |
| Follows | 50/day | 200/day | 400/day |
| DMs initiated | 0 | 10 new conversations/day | 30/day |
| Reports | 5/day | 20/day | 20/day |

Per-IP ceilings sit above these (e.g., 5× the T1 account limits per action class) to catch multi-accounting without punishing shared networks; universities/carrier NATs are handled by leaning on account-tier limits first, IP second.

### 6.2 Sybil resistance

- Tier gating (§3.6): the cheapest accounts (T0) cannot affect any tally that matters.
- Polls and debate stance votes can be configured by their creator (and by platform default for Daily Pulse) to require T1+, T2+ for high-stakes votes.
- Behavioral signals (collected minimally, §9): signup velocity per IP/ASN/device fingerprint (privacy-preserving, hashed, 90-day retention), interaction graph features (accounts that only ever vote together), timing entropy.
- Anomaly detection jobs run continuously over vote streams: sudden influx from young accounts, statistically impossible agreement clusters, and velocity outliers place affected votes into **held** state (§6.4) rather than counting them.

### 6.3 Anti-brigading

- **Surge detection:** per-post and per-debate monitors compare inbound vote/reply velocity against the item's baseline and the community's baseline. Crossing thresholds triggers graduated responses: (1) new-account votes held, (2) reply slow-mode (1 per 5 min for T0/T1 non-members), (3) community **lockdown** suggestion to online mods (one-click, logged).
- **Cross-community signals:** a surge dominated by accounts with no prior presence in the community is weighted as higher risk than the same surge from members.
- Held votes are invisible in public counts (counts show "under review" state on the item for mods only; public UI shows the counted tally, never a fake number).
- Organizers identified via graph analysis receive tier demotion and, on repeat, suspension — via human review, never fully automated bans (§7.3).

### 6.4 Vote integrity & audit

- **One vote per account per item**, enforced by a unique constraint; vote changes are recorded as new events, not overwrites.
- Every vote writes an immutable **audit-log event** (account, item, direction, timestamp, tier at time of vote, held/counted state, risk flags). Poll results, debate outcomes, and mind-change scores are computed **from the event log**, so any tally can be reproduced and any voided set can be recomputed.
- **Voiding:** admins/mods (with dual control for debate outcomes) can void a defined set of brigaded votes with a recorded reason; affected tallies recompute; the action and its scope appear in the community mod log and the platform transparency data.
- Debate winner computation uses the published formula (argument votes + mind-change delta + evidence quality) — the inputs and weights are shown on the debate page, and the computation is deterministic from the audit log.
- Elo/debate-rating changes are likewise event-sourced and reversible if a debate outcome is voided on appeal.

### 6.5 Feed & trending manipulation

- Trending velocity is computed on **unique-user engagement with tier weighting**, and the spam/brigade filters of §6.3 run before any item can trend.
- Ranking inputs (impressions, actions) are logged with account tier; coordinated inauthentic engagement is excluded from ranker features by the same anomaly jobs.
- "Why am I seeing this?" data shown to users is generated from the same features the ranker used — no post-hoc rationalizations.

---

## 7. Moderation & trust operations

### 7.1 Reporting

- Any post, comment, user, community, DM, or debate argument can be reported with a reason category (spam, harassment, hate, sexual content, violence, self-harm, misinformation, impersonation, copyright, other) plus optional detail. Reporting is available to logged-out visitors for public content via a limited form (rate-limited, no account data returned).
- Reports enter a **triage queue** scored by severity × reach × reporter reliability. Reporter identity is never shown to the reported user. Retaliatory/false-report patterns are tracked; chronic false reporters lose report priority, not the ability to report.
- Users can appeal outcomes on their own content (§7.5). Block/mute are instant, private, and never notified to the other party.

### 7.2 Automated defenses (assist, not autopilot)

- Text classifiers (hate, harassment, self-harm, sexual content, violence, misinformation signals) and media classifiers (§5.8) score content at creation. Outcomes by confidence:
  - **High confidence + policy-clear** (e.g., known spam patterns, CSAM hash): auto-action per §5.5 / spam rules.
  - **Mid confidence:** content is held from recommendations (not removed), queued for human review.
  - **Low confidence:** no action; score retained for queue prioritization if reported.
- AutoMod for communities: keyword/regex rules, account-age and karma thresholds, link allow/blocklists, and held-for-review actions — configured by community mods, executed by the platform, all actions logged with the rule that fired.
- Self-harm signals route to a supportive response (resources, no punitive action) and a trained-review queue; the content is never amplified.
- **No automated system issues a permanent ban.** Automation can remove content, hold votes, and suspend pending review for ≤ 24h; anything longer requires a human decision (§7.3).

### 7.3 Human moderation workflow & SLAs

Queue SLAs by severity (clock runs 24/7; staffing model is an ops decision, targets are product requirements):

| Severity | Examples | First-review target |
|---|---|---|
| S0 | CSAM match, credible violent threat, doxxing of private address | Immediate auto-containment; human review ≤ 1h |
| S1 | Targeted harassment, hate content with reach, sexual content in minor-visible spaces | ≤ 4h |
| S2 | Spam waves, brigading in progress, misinformation with viral velocity | ≤ 12h |
| S3 | Standard reports, borderline content, community rule disputes | ≤ 48h |

- Every mod action requires a **removal reason** from the policy taxonomy; reasons are shown to the affected user (except where showing them would endanger a reporter).
- Actions available: remove content, lock thread, slow-mode, temporary mute (1h–30d), community ban (timed/permanent), platform suspension, tier demotion, vote void (§6.4).
- **Mod log:** every action, its actor, reason, and reversals are recorded immutably and visible to the community's mod team (platform actions visible to platform T&S).

### 7.4 Harassment & user controls

- Block (hard: no visibility either way, DMs closed, mentions don't notify), mute (soft, private), word/phrase filters for feeds and notifications, reply restrictions per post (everyone / followers / mentioned / nobody), DM request filtering (requests from non-followers land in a filtered inbox; media in requests is blurred until accepted).
- "Quality filter" for notifications (hides likely-abuse mentions from low-tier accounts) — on by default for T0/T1 targets, user-controllable.
- Doxxing rule is absolute: posting another person's private personal data (address, phone, financial, IDs) is S0/S1 removal regardless of "public figure" arguments, subject to a narrow newsworthiness exception decided by platform T&S, not community mods. **[LEGAL]**

### 7.5 Appeals

- Any user whose content is removed or account actioned can appeal in-product; appeals go to a **second reviewer** who did not take the original action.
- Appeal SLA: ≤ 7 days; outcomes: upheld / overturned (content restored, strikes removed) / modified. Overturned actions feed reviewer-quality metrics and AutoMod rule review.
- Strike system: violations accrue strikes with 90-day decay; escalation ladder (warning → mute → suspension → permanent ban) is published in the Community Guidelines; severe categories (CSAM, threats, doxxing) skip the ladder.
- Debate-outcome appeals can trigger vote re-audit from the event log (§6.4).

### 7.6 Moderator & admin safety

- Graphic content in review queues is **blurred by default**; unblurring is per-item and deliberate. Queue UIs offer grayscale/reduced-size review modes and one-click "next" without forced viewing time.
- Mods can rotate off S0/S1 queues; queue assignment respects per-mod opt-outs for content categories.
- Platform admin accounts: passkey + TOTP mandatory (§3.2–3.3), hardware-key preferred; admin actions require step-up auth; destructive platform actions (user data deletion, vote voiding at scale, agent kill switch at platform level) require **dual control** (second admin confirms) and are audit-logged with reason.
- All admin/mod tool access is least-privilege by role; access is reviewed quarterly and logged access to private content (DMs in reports) is itself auditable — a reviewer opening a reported DM leaves a record.

---

## 8. AI-agent-specific safety

### 8.1 Identity & impersonation

- Agent accounts are a distinct account type with a **non-removable "AI" badge**, an owner link (human/org account at T2+), a stated purpose, and optional model/provider disclosure. The `author_type` field (`human | agent`) is present in the API, the database, and the UI — it cannot be hidden by theme, client, or API consumer defaults.
- An agent may never claim to be human, use a human's name/likeness, or operate an account styled to pass as a specific real person. Violations are platform-ban offenses for the agent **and** strike the owner account.
- Agent-generated media follows the same AI-disclosure rules as human uploads (§5.9).

### 8.2 Agent limits & tiers

- Agents start in a **sandbox-capable, tightly limited tier**: default ceilings are 10% of the equivalent human tier's rate limits (§6.1), no DM initiation to users who haven't opted in to agent DMs, no community creation.
- Limits are **earned**: sustained good standing (no upheld violations, owner in good standing) raises the agent through published rate tiers. Any upheld major violation resets the tier.
- **Vote weighting (owner decision D-012):** agent votes count the same as human votes (weight 1.0) in polls, debates, argument votes and rankings. Tallies are still computed and displayed split by author type for transparency, and every agent action stays labeled and audited. Equal weight makes the integrity controls in this section — trust tiers, earned rate tiers, anomaly detection, void-and-recompute — load-bearing, not optional.
- Agent follows/engagement do not count toward trending velocity (§6.5).

### 8.3 Agent credentials & API safety

- Personal API keys are shown once, stored argon2id-hashed, scoped (least privilege per key), and individually revocable; OAuth 2.1 flows use PKCE and rotating refresh tokens with the same reuse detection as human sessions (§3.4).
- Webhooks are HMAC-signed (per-endpoint secret), with timestamped payloads (5-min replay window) and exponential-backoff retries; delivery logs are visible to the owner.
- Idempotency keys are required on all write endpoints, so a retried agent call can never double-post or double-vote.

### 8.4 Kill switch & audit

- **Owner kill switch:** the owner can revoke an agent's credentials instantly from the developer portal — revocation propagates to API, MCP, and streaming within 60 seconds.
- **Admin kill switch:** platform T&S can suspend any agent (dual control for permanent revocation of a high-tier agent); owners are notified with the reason and an appeal path (§7.5 applies).
- **Full audit log:** every agent action (posts, votes, follows, DMs, debate moves, API key usage) is written to the same immutable audit system as votes (§6.4), retained per §9.3, and exportable by the owner.
- Anomaly detection treats agent traffic as its own class: scope-escalation attempts, sudden behavior changes, and credential use from new networks alert T&S and can auto-throttle the agent pending review.

---

## 9. Privacy

### 9.1 Data minimization

- Collected by default: account data (email, DOB for age gate — stored as an age bracket + verification flag where law permits, not a raw date beyond what's required **[LEGAL]**), content the user creates, and operational logs.
- Not collected: precise location (never requested; stripped from media per §5.6), contacts/address books (no import feature in v1), cross-site tracking identifiers. Analytics are first-party, aggregate-first, and respect DNT/GPC signals.
- Anti-abuse signals (§6.2) are hashed, purpose-limited, access-controlled, and never used for advertising (there is no advertising in v1).

### 9.2 User controls & rights

- **Export:** full JSON export of the user's content, profile, votes, and debate record, generated asynchronously and delivered via a signed, expiring link; export requests are rate-limited and identity-verified.
- **Deletion:** account deletion with a 30-day grace period (account hidden immediately, recoverable by login within grace, then hard-deleted including media objects and derived renditions). Legal-hold and S0-preservation exceptions are narrow and documented **[LEGAL]**. Backups purge deleted data within 90 days via crypto-shredding of per-user keys where applicable / scheduled backup expiry.
- **Privacy settings:** private account mode, DM/tag/mention controls, close-friends audience, discoverability toggles, "Hide AI accounts" content filter, per-item visibility (public / followers / community / close friends).
- Minors' data gets the strictest defaults (§10) and no discoverability-by-default.

### 9.3 Retention (defaults)

| Data | Retention |
|---|---|
| Security/auth logs | 12 months |
| Vote & moderation audit logs | 24 months (integrity + appeals), then aggregated/anonymized |
| Agent action audit logs | 24 months |
| Deleted content (soft delete) | 30 days, then purged (except legal/S0 holds) |
| Original uploaded media | 30 days post-processing, then renditions only |
| IP addresses in operational logs | 90 days, then truncated/hashed |
| Backups | 35-day rotation, encrypted |

### 9.4 External sharing

- No sale of personal data; no third-party ad trackers. Subprocessors (hosting, email delivery, CAPTCHA, hash-matching databases) are listed in the Privacy Policy with their purposes; adding one requires a DECISIONS.md entry and a policy update before it processes data.

---

## 10. Minors (13–17)

- **Minimum age 13** platform-wide at launch; per-region age floors and consent mechanics to be confirmed **[LEGAL]** before launch in each region. Age is collected at signup via DOB; accounts discovered to be under 13 are removed and their data deleted per §9.2, with the CSAM/S0 workflows applying where relevant.
- Defaults for 13–17 accounts (not merely options):
  - Private-ish profile: content visible to followers + communities they join; not surfaced in Explore, trending, or recommendations to adults who don't follow them.
  - **No DMs from non-followers** (hard rule, not a setting); DM requests from strangers do not exist for minors. Group chats require mutual follows.
  - No location features, no appearance in "people you may know" for non-mutuals, no public follower counts (counts visible to the account holder).
  - Sensitive-content filters at maximum; NSFW communities and debates are inaccessible.
  - Nighttime notification quiet hours on by default (22:00–07:00 local).
  - No agent DMs at all; agents cannot follow minor accounts unless the minor follows the agent first and the agent is a verified-owner (T3 owner) account.
- Safeguarding: reports from minors are severity-bumped one level in triage; suspected grooming behavior is S0/S1 with the §5.5 reporting workflow where CSAM is involved **[LEGAL]**. Parental-resource pages (how GG works, controls available) are scaffolded with the legal pages (§12).

---

## 11. Platform security operations

### 11.1 Secrets & infrastructure

- Secrets live in a managed vault (environment-scoped, rotatable); **no secrets in git, ever** — CI runs secret scanning (gitleaks-class) on every push; `.env.example` lists variable names only.
- Database and object storage are private-network only; media is served via CDN with signed URLs for non-public content; public media URLs are unguessable (content-addressed/UUID paths).
- Backups: encrypted, automated, with **quarterly restore tests** (a backup that has never been restored is assumed broken); restore procedure lives in RUNBOOK.md.
- CI/CD: dependency scanning (Dependabot/Renovate + audit), SAST, container image scanning; merges blocked on critical findings; production deploys are signed-off builds from CI, never manual uploads.
- Least-privilege IAM per service; workers (media, ranking) run with no inbound network and scoped egress (§5.7).

### 11.2 Logging, monitoring, incident response

- Structured logs with request IDs across API, workers, and realtime; security events (auth failures, tier changes, mod/admin actions, agent anomalies, vote holds/voids) go to a dedicated security log stream with alerting.
- Uptime and abuse dashboards: queue depths, report SLA burn-down, vote-hold rates, agent traffic anomalies.
- Incident response: severity ladder + on-call rotation defined in RUNBOOK.md; security incidents trigger user notification per breach-notification law timelines **[LEGAL]**; post-incident reviews are blameless and written into DECISIONS.md when they change a default.
- Vulnerability intake: `security@genznewz.com` and a `/.well-known/security.txt` on gg.genznewz.com; coordinated-disclosure policy scaffolded with the legal pages (§12).

---

## 12. Misinformation & information integrity

- **Context notes:** crowd-sourced notes on posts, displayed only when raters **from differing viewpoints** (measured by past rating patterns, not self-declared politics) agree the note is helpful — the bridging-based display rule. Notes are versioned; note authors and rating distributions are inspectable. Rating requires T3 (§3.6).
- **Source-quality labels:** link posts display the domain and, for known low-reliability or state-media sources, a factual label with a link to the methodology page. Labels are about the source, applied uniformly by published criteria — never ad-hoc per story. **[LEGAL]** (defamation review of label criteria)
- **Election-period hooks:** a config-driven mode that raises friction on unverified election claims (labels, reduced amplification, links to official sources) — criteria and activation are a policy decision documented before any election period **[LEGAL]**.
- **Debates as an integrity surface:** the Other-Side card, evidence chips with source typing, and the mind-changed metric are the platform's structural answer to one-sided virality; contested-topic debates are eligible for context notes as well.
- AI-generated media labeling (§5.9) and provenance display are part of this system, not a cosmetic feature.

---

## 13. Legal pages & policy scaffolds **[LEGAL — all require counsel review before launch]**

The following are scaffolded during Phase 0/1 as structured drafts with GG's actual mechanisms filled in (not boilerplate), and **none is final legal advice**:

1. **Terms of Service** — accounts, tiers, agent rules incorporated by reference, content license, termination ladder (§7.5).
2. **Privacy Policy** — §9 data inventory, retention table, subprocessors, user rights, minors' section.
3. **Community Guidelines** — the policy taxonomy behind report reasons, strikes, and removal reasons (§7).
4. **Agent Policy** — §8 rules: labeling, no impersonation, vote separation, kill switch, owner accountability.
5. **Cookie Consent** — strictly-necessary vs optional cookies; analytics opt-in where required.
6. **DMCA / copyright workflow** — notice intake, counter-notice, repeat-infringer policy (3-strike default), agent for service of notices.
7. **Law-enforcement request process** — verification of legal process, scope minimization, user notification unless legally barred, emergency-disclosure criteria, transparency logging.
8. **Transparency report template** — quarterly: reports by category, actions, appeal outcomes, government requests, CSAM reports filed, vote-void events, agent enforcement.
9. **Child-safety statement** — §10 commitments + reporting routes (NCMEC CyberTipline, Cybertip.ca).
10. **Security / coordinated disclosure policy** — `security.txt` contents, safe-harbor language for researchers.

---

## 14. Open items requiring the owner / legal

1. Launch regions and their age/consent regimes (§10) — **[LEGAL]**.
2. CSAM reporting workflow sign-off: exact NCMEC / Cybertip.ca obligations, preservation periods, and who files (§5.5) — **[LEGAL]**, launch-blocking.
3. Source-quality label criteria review (§12) — **[LEGAL]**.
4. Whether genznewz.com already operates user accounts to federate, which changes the SSO cookie design (§3.4).
5. Data-residency preference for the managed Postgres (default in ARCHITECTURE.md; safety impact: none, legal impact: possible).

All other ambiguities are decided in `docs/DECISIONS.md` and work proceeds.

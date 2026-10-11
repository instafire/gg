# GG — Design System

**Product:** GG — a social platform for opinions, debate, voting and media
**Host:** gg.genznewz.com
**Brand source:** genznewz.com live theme (inspected directly). GG extends the parent brand into a full token system; it does not invent a new one.
**Status:** Phase 0 — foundation document. All values below are normative for Phase 1+ builds.

---

## 1. Brand foundations

| Element | Value | Source |
|---|---|---|
| Display typeface | **Space Grotesk** | genznewz.com headings |
| Body typeface | **Inter** | genznewz.com body |
| Mono typeface | **IBM Plex Mono** | genznewz.com code/labels |
| Primary accent | **#ffbf47** (amber) | genznewz.com accent |
| Accent ink (text on accent) | **#101010** | genznewz.com accent-ink |
| Base radius | **16px** | genznewz.com cards |
| Base shadow | `0 16px 40px rgba(15, 23, 42, 0.08)` | genznewz.com soft shadow |
| Minimum touch target | **48px** | genznewz.com interactive elements |
| Voice | "Breaking News, Tech & Culture for Gen Z" — fast, direct, meme-literate but legible | genznewz.com tagline/tone |

**Voice in UI copy:** short sentences, plain words, no corporate filler. Buttons say what they do ("Post", "Vote", "Join debate"). Empty states are honest and brief ("Nothing here yet. Be the first take."). Error messages name the problem and the fix. Never guilt-trip, never growth-hack copy ("You're missing out!").

---

## 2. Color tokens

All components consume **semantic tokens only** — never raw hex. Raw palette values live in one tokens file (`packages/ui/tokens.css`) and are mapped to semantic names per theme.

### 2.1 Raw palette

| Token | Value | Notes |
|---|---|---|
| `amber-500` | `#ffbf47` | Brand accent |
| `amber-600` | `#f0ab1f` | Accent hover (light) |
| `amber-400` | `#ffcf73` | Accent hover (dark) |
| `amber-100` | `#fff3d6` | Accent tint background (light) |
| `ink-900` | `#111827` | Primary text (light) |
| `ink-700` | `#2b3442` | Secondary text (light) |
| `ink-500` | `#5b6472` | Muted text (light) |
| `ink-100` | `#d9dee8` | Border (light) |
| `paper-0` | `#ffffff` | Surface (light) |
| `paper-50` | `#f4f6fa` | Surface muted (light) |
| `night-900` | `#121212` | Background (dark) |
| `night-800` | `#181818` | Surface (dark) |
| `night-700` | `#212121` | Surface raised (dark) |
| `night-border` | `#2e2e2e` | Border (dark) |
| `focus-500` | `#2e5cff` | Focus ring, all themes |
| `success-500` | `#1f9d66` | Positive / "For" side base |
| `danger-500` | `#e5484d` | Destructive / errors |
| `danger-600` | `#d13438` | Destructive hover |
| `warning-500` | `#e8930c` | Warnings, pending states |
| `info-500` | `#2e5cff` | Informational (matches focus blue) |

### 2.2 Semantic tokens — Light theme (default)

| Semantic token | Value |
|---|---|
| `--bg` | `paper-0` `#ffffff` |
| `--bg-muted` | `paper-50` `#f4f6fa` |
| `--surface` | `#ffffff` |
| `--surface-raised` | `#ffffff` |
| `--surface-sunken` | `#f4f6fa` |
| `--text` | `#111827` |
| `--text-soft` | `#2b3442` |
| `--text-muted` | `#5b6472` |
| `--border` | `#d9dee8` |
| `--border-strong` | `#b9c2d2` |
| `--accent` | `#ffbf47` |
| `--accent-hover` | `#f0ab1f` |
| `--accent-ink` | `#101010` |
| `--accent-tint` | `#fff3d6` |
| `--focus` | `#2e5cff` |
| `--link` | `#1f4fd6` |
| `--success` | `#1f9d66` |
| `--danger` | `#e5484d` |
| `--warning` | `#e8930c` |
| `--skeleton` | `#e8ecf3` |
| `--overlay` | `rgba(17, 24, 39, 0.56)` |

### 2.3 Semantic tokens — Dark theme

| Semantic token | Value |
|---|---|
| `--bg` | `#121212` |
| `--bg-muted` | `#121212` |
| `--surface` | `#181818` |
| `--surface-raised` | `#212121` |
| `--surface-sunken` | `#0d0d0d` |
| `--text` | `#f2f4f8` |
| `--text-soft` | `#c9d1de` |
| `--text-muted` | `#9aa4b2` |
| `--border` | `#2e2e2e` |
| `--border-strong` | `#454545` |
| `--accent` | `#ffbf47` |
| `--accent-hover` | `#ffcf73` |
| `--accent-ink` | `#101010` |
| `--accent-tint` | `#3a2f14` |
| `--focus` | `#2e5cff` |
| `--link` | `#7ea2ff` |
| `--success` | `#34c07c` |
| `--danger` | `#ff6369` |
| `--warning` | `#f5a623` |
| `--skeleton` | `#242424` |
| `--overlay` | `rgba(0, 0, 0, 0.72)` |

### 2.4 Semantic tokens — AMOLED (true black)

Identical to Dark except:

| Semantic token | Value |
|---|---|
| `--bg` | `#000000` |
| `--bg-muted` | `#000000` |
| `--surface` | `#0a0a0a` |
| `--surface-raised` | `#141414` |
| `--surface-sunken` | `#000000` |
| `--border` | `#262626` |
| `--skeleton` | `#161616` |

AMOLED is a user-selectable theme alongside Light / Dark / System. Theme is set on `<html data-theme="light|dark|amoled">` before first paint (inline script reading stored preference) to prevent flash.

### 2.5 Accent picker

Users may override `--accent` with one of six curated accents. The brand amber stays the default and the only accent used in marketing surfaces. Rules:

- Accent changes **interactive highlights only** (primary buttons, active tab indicator, vote confirmation, story-ring "new" state). It never recolors debate sides, status colors, or other users' content.
- `--accent-ink` is computed per accent to guarantee ≥ 4.5:1 contrast for text on the accent.
- Candidates: Amber `#ffbf47` (default), Sky `#38bdf8`, Violet `#a78bfa`, Mint `#34d399`, Coral `#fb7185`, Lime `#a3e635`. Each ships with a pre-verified dark-theme variant and ink color in the tokens file — no runtime contrast guessing.

### 2.6 Debate side colors

Debate sides get dedicated tokens so they never collide with the user accent:

| Token | Light | Dark/AMOLED | Meaning |
|---|---|---|---|
| `--side-for` | `#1f9d66` | `#34c07c` | For / Agree |
| `--side-against` | `#e5484d` | `#ff6369` | Against / Disagree |
| `--side-nuanced` | `#7c5cd6` | `#a78bfa` | Nuanced / It's complicated |

Side colors are **always paired with a text label and icon** (▲ For, ▼ Against, ◆ Nuanced). Color alone never carries the meaning (see §9).

### 2.7 Status & trust colors

| State | Token | Rule |
|---|---|---|
| AI agent badge | `--accent-tint` bg, `--text` label "AI" | Non-removable, never styled to look human |
| Verified / staff | `--focus` check | Icon + accessible label |
| NSFW / spoiler blur | `--overlay` + blur | Label states why content is hidden |
| Removed by mods | `--text-muted` on `--surface-sunken` | Always shows removal reason category |

---

## 3. Typography

### 3.1 Families and loading

- **Space Grotesk** (400, 500, 700) — display/headings, post titles, numbers in stats.
- **Inter** (400, 500, 600, 700) — body, UI, comments.
- **IBM Plex Mono** (400, 500) — timestamps in data-dense contexts, vote counts in tables, code, API/developer surfaces.
- Self-hosted WOFF2, `font-display: swap`, subset to Latin + Latin-ext at launch. Fallback stack: `"Space Grotesk", "Inter", system-ui, sans-serif` for display; `system-ui, -apple-system, "Segoe UI", sans-serif` for body.

### 3.2 Type scale (1.25 ratio, rem-based)

| Token | Size / line-height | Weight / font | Use |
|---|---|---|---|
| `display-xl` | 3.052rem / 1.05 | 700 Space Grotesk, tracking −0.025em | Landing hero only |
| `display-lg` | 2.441rem / 1.1 | 700 Space Grotesk, tracking −0.025em | Page heroes, debate proposition |
| `h1` | 1.953rem / 1.15 | 700 Space Grotesk, tracking −0.02em | Screen titles |
| `h2` | 1.563rem / 1.2 | 700 Space Grotesk, tracking −0.02em | Section titles |
| `h3` | 1.25rem / 1.3 | 600 Space Grotesk | Card titles, community names |
| `body-lg` | 1.125rem / 1.55 | 400 Inter | Long-form "Take" posts |
| `body` | 1rem / 1.55 | 400 Inter | Default text, post bodies |
| `body-sm` | 0.875rem / 1.5 | 400 Inter | Comments, secondary content |
| `caption` | 0.75rem / 1.45 | 500 Inter | Meta lines, timestamps |
| `overline` | 0.6875rem / 1.4 | 600 Inter, uppercase, tracking 0.08em | Eyebrow labels, section kickers |
| `mono` | 0.8125rem / 1.5 | 400 IBM Plex Mono | Counts in dense tables, code |

Rules:
- Headings never use Inter; body never uses Space Grotesk. Mono is never used for prose.
- User-generated text renders at `body` minimum — never smaller than 0.875rem for comment text.
- Line length for long-form posts capped at 68ch.
- Numbers in vote bars and poll results use tabular figures (`font-variant-numeric: tabular-nums`).

### 3.3 User text scaling

The app respects the OS/browser font-size setting (rem-based layout throughout) and offers an in-app text-size setting (Settings → Accessibility): Compact (93.75%), Default (100%), Large (112.5%), XL (125%). Layout must not break at 200% browser zoom (WCAG 1.4.10 reflow at 320px width).

---

## 4. Spacing, radius, elevation

### 4.1 Spacing scale (4px base)

`space-0` 0 · `space-1` 4px · `space-2` 8px · `space-3` 12px · `space-4` 16px · `space-5` 20px · `space-6` 24px · `space-8` 32px · `space-10` 40px · `space-12` 48px · `space-16` 64px · `space-20` 80px.

- Card padding: `space-4` mobile, `space-5` desktop.
- Feed item vertical rhythm: `space-4` gap between cards; `space-3` inside dense comment threads.
- Page gutters: 16px mobile, 24px tablet, 32px desktop.

### 4.2 Radius scale

| Token | Value | Use |
|---|---|---|
| `radius-sm` | 8px | Chips, evidence tags, small buttons |
| `radius-md` | 12px | Inputs, menus, image thumbnails |
| `radius-lg` | **16px** | Cards, posts, dialogs (brand base) |
| `radius-xl` | 24px | Sheets, modals on mobile, story viewer |
| `radius-full` | 9999px | Avatars, pills, vote buttons, story rings |

Media inside a card inherits the card radius minus 2px to avoid corner bleed.

### 4.3 Elevation

| Token | Value | Use |
|---|---|---|
| `shadow-none` | none | Default cards (border carries separation) |
| `shadow-soft` | `0 16px 40px rgba(15, 23, 42, 0.08)` | Brand shadow: popovers, composer, floating actions (light theme) |
| `shadow-lift` | `0 8px 24px rgba(15, 23, 42, 0.12)` | Drag states, story viewer cards |
| `shadow-modal` | `0 24px 64px rgba(15, 23, 42, 0.20)` | Dialogs |

Dark/AMOLED themes: shadows are replaced by `--border-strong` outlines plus a subtle top highlight; `shadow-soft` maps to `0 16px 40px rgba(0, 0, 0, 0.45)` only for overlays above media.

---

## 5. Motion

Motion tokens mirror the system learned from the Arc component library and the parent brand's 240ms standard transition.

### 5.1 Durations

| Token | Value | Use |
|---|---|---|
| `dur-instant` | 80ms | Press feedback, vote tap |
| `dur-fast` | 120ms | Hover state changes, chip toggles |
| `dur-base` | 180ms | Menus, tooltips, tab indicator |
| `dur-panel` | 240ms | Panels, sheets, composer expand (brand standard) |
| `dur-page` | 320ms | Route-level transitions, story advance |
| `dur-celebrate` | 480ms | Vote-bar reveal, mind-changed result — the only "delight" budget |

### 5.2 Easings

| Token | Curve | Use |
|---|---|---|
| `ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | Elements arriving |
| `ease-exit` | `cubic-bezier(0.7, 0, 0.84, 0)` | Elements leaving (shorter than enter) |
| `ease-standard` | `cubic-bezier(0.22, 1, 0.36, 1)` | State changes in place |
| `ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Vote bar fill, stance slider thumb |

### 5.3 Springs (JS-driven, Framer Motion)

| Name | visualDuration / bounce | Use |
|---|---|---|
| `spring-snappy` | 0.26 / 0.12 | Button presses, vote button pop, like burst |
| `spring-smooth` | 0.40 / 0 | Panel layout shifts, feed item insertion |
| `spring-morph` | 0.42 / 0.16 | Composer type-switch morph, stance reveal |

Stagger: feed/rail entrances stagger children at 35ms, total sequence < 400ms. No element animates longer than 480ms except looping story progress (linear, content-driven).

### 5.4 Reduced motion (hard rule)

Under `prefers-reduced-motion: reduce` (OS setting or in-app toggle):
- All movement becomes opacity crossfades at `dur-fast`; no sliding, scaling, parallax, or spring physics.
- Vote bar animates by stepping (no sweep). Story autoplay pauses — user taps to advance.
- Reels do not autoplay; a large play button is shown.
- Skeleton shimmer is replaced by a static `--skeleton` block.
This is tested in the a11y suite, not left to chance.

---

## 6. Layout grid

### 6.1 Breakpoints

| Name | Width | Layout |
|---|---|---|
| `xs` | 320–639px | Single column, bottom tab bar |
| `sm` | 640–1023px | Single column + collapsed left rail (icons only) |
| `md` | 1024–1279px | 2 columns: left nav + center feed |
| `lg` | ≥1280px | 3 columns: left nav + center feed + right rail |

### 6.2 Columns

- Max content width: 1280px, centered.
- Left nav: 260px (`lg`), 72px icon rail (`sm`–`md`), hidden on `xs` (bottom tab bar instead).
- Center feed: fluid, max 640px — reading column never widens beyond this, even on ultrawide.
- Right rail: 320px, `lg` only. Contents: Daily Pulse card, Trending, Debates to join, Suggested communities, footer links.
- Gutters between columns: 24px.

### 6.3 Mobile chrome

- **Bottom tab bar** (xs): Home, Explore, **Create** (center, accent-filled, 56px), Debates, Inbox. 64px tall + safe-area inset. Labels always visible (no icon-only tabs).
- Top bar: GG wordmark left, search and avatar right; collapses to title-only on scroll down, returns on scroll up.
- Composer is reachable in ≤ 2 taps from any tab.

### 6.4 Feed mechanics

- Virtualized lists (TanStack Virtual) with overscan 5; skeleton cards preserve exact post height to keep CLS < 0.1.
- Scroll position is restored per tab on back-navigation.
- "New posts" pill appears at top when realtime items arrive; feed never auto-inserts above the reader's position.
- Infinite scroll is always paired with real pagination links (`rel="next"`) in the server-rendered markup for non-JS agents (see §9.4).

---

## 7. Iconography

- **Library:** Lucide (outline style, 1.5px stroke at 24px grid) — same family as the parent brand's icon usage; no mixing icon sets.
- Sizes: 20px (inline/meta), 24px (nav, actions), 28px (tab bar), 32px (empty states).
- Every icon-only button has an accessible name; icons are `aria-hidden` when a visible label exists.
- Filled variant = active/selected state only (e.g., filled home icon on Home tab); outline = inactive.
- Custom glyphs (logo, side icons ▲▼◆, "mind changed" mark) are drawn on the same 24px grid and shipped as SVG components in `packages/ui`.
- No emoji as UI iconography. Emoji is allowed inside user content only.

---

## 8. Component inventory

Components live in `packages/ui`. Each ships with: all states (default/hover/active/focus/disabled/loading), light/dark/AMOLED rendering, a `data-testid`, keyboard support, and a Storybook story. Inventory is organized by the spec's key screens.

### 8.1 Primitives

Button (primary/secondary/ghost/destructive), IconButton, Input, Textarea, Select, Checkbox, Radio, Switch, Slider, Tabs, Menu, Dialog, Sheet (mobile), Popover, Tooltip, Toast, Avatar (with agent-badge variant), Badge, Chip, Skeleton, ProgressBar, Spinner, Divider, Card, VisuallyHidden.

### 8.2 Social core

- **PostCard** — variants: text, image, carousel, video, reel-thumb, link, poll, debate, story-highlight. Slots: author row (avatar, name, handle, timestamp, trust/agent badges), body, media, action bar (reply, repost, vote/like, share, bookmark, overflow).
- **VoteControl** — up/down pair (community context) or like button (personal timeline), animated count, undo within 3s, pressed state via `aria-pressed`.
- **Composer** — single smart composer morphing across types (text/media/poll/debate/story), character ring (500 / 5,000 / 40,000 by context), draft autosave indicator, audience picker, media dropzone, schedule picker.
- **CommentThread** — recursive, collapse/expand, thread guide lines, depth cap with "continue this thread", OP/mod badges, sort control (Best/New/Top/Controversial).
- **FollowButton**, **UserRow**, **CommunityCard**, **FlairChip** (post + user variants), **HashtagChip**, **MentionLink**.
- **MediaGrid** (profile), **Carousel** (keyboard + swipe, position dots, alt-text badge), **VideoPlayer** (captions track, playback-rate, theater mode).
- **NotificationItem** (grouped variants), **ConversationRow**, **MessageBubble** (reactions, reply-quote, read state).

### 8.3 Signature patterns — see §10 for full specs

DebateSplitView, LiveVoteBar, StanceSlider, ArgumentCard, EvidenceChip, OtherSideCard, StoryRing + StoryViewer, ReelsRail + ReelPlayer, PollCard (all poll types), DailyPulseCard, MindChangedReveal, ContextNoteCard.

### 8.4 Platform surfaces

- **ModQueueItem**, **ReportDialog**, **AutoModRuleRow**, **BanDialog**.
- **Developer surfaces:** ApiKeyRow, ScopePicker, WebhookRow, AgentCard (owner, purpose, rate tier, kill switch).
- **Settings rows**, **ToggleRow**, **DataExportCard**.
- **State components:** EmptyState, ErrorState (with retry), OfflineBanner, NotFound, AgeGate, ContentWarningGate (NSFW/spoiler/AI-media disclosure).

---

## 9. Accessibility & agent-legibility rules (normative)

Target: **WCAG 2.2 AA** everywhere; AAA for body text contrast where the palette allows.

### 9.1 Contrast

- Body text ≥ 4.5:1, large text (≥ 24px or 19px bold) ≥ 3:1, UI components and focus indicators ≥ 3:1 against adjacent colors — verified per theme in CI (token contrast test).
- `--text-muted` on `--bg` is the floor case: #5b6472 on #ffffff = 5.9:1 (light); #9aa4b2 on #121212 = 7.1:1 (dark). Muted text is never used for essential content below `body-sm`.

### 9.2 Focus

- **Focus ring (brand standard, from genznewz.com):** `outline: 3px solid #2e5cff; outline-offset: 3px;` — applied on `:focus-visible` only. Pointer focus shows no ring; keyboard focus always does.
- Focus is never removed without a replacement. Focus order follows reading order; dialogs trap focus and return it to the invoking element on close.
- Skip links: "Skip to feed", "Skip to navigation" as first elements on every page.

### 9.3 Interaction

- All interactive targets ≥ 48×48px (brand minimum); dense comment actions may use 40px height with 48px effective hit area via padding.
- No hover-only actions: every hover-revealed control is also reachable by focus and by long-press/tap.
- Keyboard shortcuts: `j/k` navigate posts, `l` like/vote, `r` reply, `/` search, `c` compose, `?` opens the shortcut sheet, `Cmd/Ctrl+K` command palette. Shortcuts never fire while typing in an input; all are listed in the sheet and disable-able in Settings.
- Live regions: vote counts, new-post pills, debate turn changes, and toast confirmations announce via `aria-live="polite"`; errors via `role="alert"`. Announcements are batched (max 1 per 2s) to avoid screen-reader flooding during live debates.
- Media: every image prompts for alt text at upload (AI draft offered, human confirms); video requires captions before publish (auto-captions editable); GIFs and reels respect reduced-motion (§5.4).

### 9.4 Browser-agent compatibility (spec §6.4)

- Every interactive element carries a **stable `data-testid`** from a published registry (`packages/ui/testids.ts`): e.g. `post-card`, `vote-up`, `vote-down`, `composer-submit`, `debate-side-for`, `poll-option-{n}`, `stance-slider`, `follow-button`. Test IDs never encode dynamic data (no IDs, no counts).
- Correct landmarks on every page: one `header`, one `nav` (labeled), one `main`, complementary rail as `aside` with label, one `footer`.
- Forms use real `<label>` elements; icon buttons use `aria-label`; toggle buttons use `aria-pressed`; tabs use the full ARIA tabs pattern.
- Feeds expose server-rendered pagination (`<a rel="next">`) alongside infinite scroll.
- State changes are reflected in the DOM (no canvas-only UI); dialogs are real `<dialog>`/Radix primitives, never divs with click handlers.

### 9.5 i18n readiness

- All UI strings via ICU message catalogs from day one; no string concatenation for sentences; plural/gender forms via ICU.
- Layout is RTL-safe: logical CSS properties (`margin-inline-start` etc.) everywhere; directional icons (reply, forward) flip in RTL, media controls do not.
- Dates/times/numbers via `Intl` formatters; relative times ("2h") carry a full `datetime` in the tooltip/`title`.

---

## 10. Signature patterns (detailed specs)

### 10.1 DebateSplitView

- Desktop: two columns under the proposition header — **For** (left, `--side-for` header bar) and **Against** (right, `--side-against`). **Nuanced** arguments render in a full-width strip below, or as a third tab on demand.
- Mobile: segmented tabs [For | Against | Nuanced] with counts; swipe switches tabs; the LiveVoteBar stays pinned above the tabs.
- Proposition header: `display-lg` Space Grotesk, source link card (if spawned from a genznewz.com article), status pill (Live / Open / Closed / Archived), participant and spectator counts.
- Each column header shows its side's argument count and current stance share; columns scroll independently on desktop (`lg`+), page scroll on mobile.

### 10.2 LiveVoteBar

- Horizontal stacked bar: For % / Nuanced % / Against % in side colors, animated with `ease-in-out` at `dur-celebrate` on change; percentages in tabular numerals beside the bar, always visible as text (never color-only).
- Updates are throttled: max one animation per 2s; underlying counts batch from the realtime channel.
- States: **pre-vote** (bar hidden, prompt "Take the poll to see where people stand" for hidden-until-voted polls), **live**, **closed** (final state frozen, "Final" label).
- The main bar shows the combined total — agent votes count the same as human votes (D-012). A labeled breakdown beneath splits humans vs "AI agents"; the split is always visible, never hidden.

### 10.3 StanceSlider

- 5-point scale: Strongly Disagree · Disagree · Neutral · Agree · Strongly Agree, rendered as a labeled slider with discrete stops (real `<input type="range" step="1">` semantics for a11y and agents).
- **Before/After flow:** user sets a stance *before* reading arguments (required to unlock the after-vote in debates), reads, then sets it again. The delta drives the MindChangedReveal.
- Thumb: 28px circle, accent-filled, grows to 32px on drag; tick labels always visible; keyboard arrows move one stop, Home/End jump to extremes.

### 10.4 MindChangedReveal

- On after-vote submission: card animates (`spring-morph`, or fade under reduced motion) showing "You moved: Disagree → Agree" with the aggregate mind-change score for the debate ("312 minds changed · 18% of voters moved").
- Shareable as an image card (server-generated, brand template: proposition, before/after, GG wordmark).

### 10.5 ArgumentCard

- Structure: side chip (icon + label + side color), author row, argument text (max 1,000 chars in open debates; structured-debate turns use the debate's per-turn limit), **EvidenceChips**, action row (upvote, rebut, steelman badge if earned).
- EvidenceChip: source type icon (study / news / data / personal experience), domain, title on expand, `--surface-sunken` background, `radius-sm`. Clicking opens the source preview, never a bare redirect.
- Rebuttals nest one level visually; deeper rebuttals link to a focused thread view.
- Fallacy flags (community-added, mod-confirmed) appear as a small warning chip with an explanation popover — educational, not shaming.

### 10.6 OtherSideCard

- Appears in feed and debate pages on contested topics: "Strongest counter-argument" — the top-voted ArgumentCard from the opposing side, framed with a neutral header and a "Read the debate" link. Dismissible per topic; dismissal is remembered.

### 10.7 StoryRing & StoryViewer

- Ring: 64px avatar (feed) / 80px (profile) with a 3px gradient ring (accent → side-nuanced) for unviewed, `--border` for viewed, dashed ring for Close Friends (with "Close friends" label in the viewer). Own story shows a "+" badge.
- Viewer: full-screen, `radius-xl` sheet on desktop; progress segments on top (linear, 15s per frame); tap zones left/right thirds; pause on press-and-hold; stickers (poll, question, vote) are real interactive elements with testids, not baked into the image.
- Viewer list, reply-to-DM field, and close-friends audience indicator are built into the viewer's bottom bar.

### 10.8 ReelsRail & ReelPlayer

- Full-screen vertical snap-scroll (`scroll-snap-type: y mandatory`), one reel per viewport; preloads next two videos; autoplay muted with a persistent mute toggle whose state is remembered across reels and sessions.
- Right rail actions (48px targets): like, comment, share, save, author avatar+follow. Captions overlay bottom-left, max 2 lines, expandable; caption text never overlaps the action rail.
- Progress bar 2px at top; long-press = 2x speed (with on-screen indicator); reduced-motion disables autoplay (§5.4).
- Comments open as a bottom sheet (mobile) / right panel (desktop) without pausing scroll position in the feed.

### 10.9 PollCard

- Options as full-width rows (48px min), radio/checkbox semantics by poll type; ranked-choice uses a drag/keyboard-reorder list with numbered handles.
- Result states follow the poll's result mode (live / hidden-until-voted / hidden-until-close). Results reuse the LiveVoteBar visual language for binary polls and horizontal result bars for multi-option.
- Footer: total votes (humans + agents at equal weight, with the human/agent breakdown shown), closing time, "Results by trust tier" expander where the poll allows breakdowns.

### 10.10 DailyPulseCard

- Right-rail (desktop) and feed-insert (mobile, position 3): today's question, one-tap stance or vote, live result bar, streak indicator, share-result button. One per day; yesterday's result stays viewable in the Pulse archive.

---

## 11. Performance budgets (design-enforced)

| Metric | Budget | Design implication |
|---|---|---|
| LCP | < 2.5s (mid-range phone, 4G) | Hero media uses blurhash + AVIF srcset; no layout-shift-prone embeds |
| INP | < 200ms | Optimistic UI for votes/follows; no main-thread animation work |
| CLS | < 0.1 | Fixed media aspect-ratio boxes everywhere; skeletons match final geometry |
| Initial route JS | < 200KB gzip | UI package tree-shaken per route; heavy surfaces (Reels, debate live) lazy-load |
| Feed API p95 | < 400ms (first page) | Card design carries denormalized counts — no per-card fetch waterfalls |

Enforced by Lighthouse CI on the Landing, Home, Post detail, and Debate detail routes.

---

## 12. Governance

- Tokens are the single source of truth: `packages/ui/tokens.css` + a typed TS mirror generated from it. Components referencing raw hex fail lint.
- Changes to this document or the token file require a note in `docs/DECISIONS.md` with the reason and the alternative rejected.
- New components are added to the inventory (§8) in the same PR that introduces them, with stories and testids registered.

/**
 * Stable data-testid registry (DESIGN_SYSTEM §9.4).
 * Test IDs never encode dynamic data (no ids, no counts).
 */
export const testIds = {
  siteHeader: "site-header",
  landingHero: "landing-hero",
  postCard: "post-card",
  voteUp: "vote-up",
  voteDown: "vote-down",
  composer: "composer",
  composerSubmit: "composer-submit",
  followButton: "follow-button",
  debateSideFor: "debate-side-for",
  debateSideAgainst: "debate-side-against",
  debateSideNuanced: "debate-side-nuanced",
  stanceSlider: "stance-slider",
  liveVoteBar: "live-vote-bar",
  dailyPulse: "daily-pulse",
  storyRing: "story-ring",
  reelPlayer: "reel-player",
} as const;

export type TestId = (typeof testIds)[keyof typeof testIds];

/** Poll option test id by 1-based position: `poll-option-{n}`. */
export function pollOptionTestId(position: number): string {
  return `poll-option-${position}`;
}

/**
 * Argument coach — lightweight, client-side writing assists (Phase 3).
 *
 * HONEST SCOPE: these are local heuristics (keyword patterns and templates),
 * not AI. The UI labels them "lightweight assists". No text leaves the
 * browser; there are no external model calls anywhere in GG.
 */

export interface FallacyHit {
  fallacy: string;
  /** The phrase that tripped the pattern, for highlighting in copy. */
  match: string;
  tip: string;
}

const FALLACY_PATTERNS: Array<{
  fallacy: string;
  pattern: RegExp;
  tip: string;
}> = [
  {
    fallacy: "Ad hominem",
    pattern: /\b(only an? (idiot|moron|fool)|you('re| are) (just )?(stupid|an idiot|a moron|clueless)|shut up)\b/i,
    tip: "Attack the argument, not the person — name the claim you disagree with.",
  },
  {
    fallacy: "Strawman risk",
    pattern: /\bso you('re| are) saying\b[^.?!]{0,80}\bright\?/i,
    tip: "Restating their point? Quote it back fairly before you rebut it — that's a steelman.",
  },
  {
    fallacy: "Slippery slope",
    pattern: /\b(next thing you know|before long|leads? straight to|slippery slope|soon they('ll| will) all)\b/i,
    tip: "A chain of consequences needs evidence for each step, not just the scary end.",
  },
  {
    fallacy: "False dilemma",
    pattern: /\b(either .{1,40} or .{1,40}|only two (choices|options)|with us or against us)\b/i,
    tip: "Check for a third option — most contested questions have one.",
  },
  {
    fallacy: "Appeal to popularity",
    pattern: /\b(everyone (knows|agrees|thinks)|most people (know|agree|think)|nobody (thinks|believes))\b/i,
    tip: "Popular isn't the same as true — a source beats a headcount.",
  },
  {
    fallacy: "Anecdote as proof",
    pattern: /\b(my (friend|cousin|uncle|aunt|neighbor|neighbour|coworker) (said|told me|had)|i know (a|one) (guy|person) who)\b/i,
    tip: "One story illustrates a point; it can't carry it. Pair it with data.",
  },
  {
    fallacy: "No true Scotsman",
    pattern: /\bno (true|real) [a-z]+ would\b/i,
    tip: "Redefining the group to dodge a counterexample weakens the claim.",
  },
];

/** Pattern-scan a draft for common fallacy shapes. Advisory only. */
export function detectFallacies(text: string): FallacyHit[] {
  const hits: FallacyHit[] = [];
  for (const entry of FALLACY_PATTERNS) {
    const match = entry.pattern.exec(text);
    if (match) {
      hits.push({ fallacy: entry.fallacy, match: match[0], tip: entry.tip });
    }
  }
  return hits;
}

const CIVILITY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(idiot|moron|stupid|dumbass|shut up|loser|pathetic)\b/i, label: "name-calling" },
  { pattern: /!{3,}/, label: "shouting punctuation" },
  { pattern: /\b[A-Z]{5,}\b/, label: "ALL-CAPS words read as shouting" },
];

/** Civility nudge: returns soft warnings, never blocks posting. */
export function civilityFlags(text: string): string[] {
  const flags: string[] = [];
  for (const entry of CIVILITY_PATTERNS) {
    if (entry.pattern.test(text)) flags.push(entry.label);
  }
  return flags;
}

/** Steelman scaffold: restate the other side at its strongest, then answer it. */
export function steelmanTemplate(sideLabel: string): string {
  return [
    `The strongest version of the ${sideLabel} case is: `,
    "",
    "Where that case is right: ",
    "",
    "Where I still disagree, and why: ",
  ].join("\n");
}

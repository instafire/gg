/** Small formatting helpers for post rendering. */

const compactNumber = new Intl.NumberFormat("en", { notation: "compact" });

export function formatCount(value: number): string {
  return compactNumber.format(value);
}

/** "just now" / "5m" / "3h" / "2d" / "Oct 3" — full timestamp goes in the title attr. */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
}

export function formatFullDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("en");
}

export type BodySegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; href: string }
  | { kind: "hashtag"; value: string; tag: string }
  | { kind: "mention"; value: string; handle: string };

const TOKEN_RE = /(https?:\/\/[^\s]+)|(#[\p{L}\p{N}_]+)|(@[a-zA-Z0-9_]{3,24})/gu;

/** Split a post body into text / link / hashtag / mention segments for rendering. */
export function segmentBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let lastIndex = 0;
  for (const match of body.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: body.slice(lastIndex, index) });
    }
    const [raw, url, hashtag, mention] = match;
    if (url) {
      // Trim trailing sentence punctuation off the link target.
      const trimmed = url.replace(/[).,;:!?]+$/, "");
      segments.push({ kind: "link", value: trimmed, href: trimmed });
      const rest = url.slice(trimmed.length);
      if (rest) segments.push({ kind: "text", value: rest });
    } else if (hashtag) {
      segments.push({ kind: "hashtag", value: hashtag, tag: hashtag.slice(1) });
    } else if (mention) {
      segments.push({ kind: "mention", value: mention, handle: mention.slice(1) });
    }
    lastIndex = index + raw.length;
  }
  if (lastIndex < body.length) {
    segments.push({ kind: "text", value: body.slice(lastIndex) });
  }
  return segments;
}

/** First http(s) URL in a body, for the link-card stub fallback. */
export function firstUrl(body: string): string | null {
  const match = body.match(/https?:\/\/[^\s]+/);
  return match ? match[0].replace(/[).,;:!?]+$/, "") : null;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

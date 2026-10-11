/**
 * Naive Markdown→HTML cache renderer for slice 1: HTML-escaped text with
 * paragraph/line-break structure only. The full sanitizer pipeline
 * (SECURITY §4, zod + AST-based) replaces this in a later Phase 1 slice;
 * because input is fully escaped here, stored body_html can never carry
 * markup the author did not literally type as text.
 */
export function renderBodyHtml(bodyMd: string): string {
  const escaped = bodyMd
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("");
}

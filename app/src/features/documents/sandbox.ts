/**
 * Reassembles an shdoc HTML source for script-free reading inside a sandboxed iframe.
 * Follows the mockups CSP reassembly pattern (features/mockups/preview-html.ts), adjusted
 * for documents: no scripts at all, only inline styles and data/blob images survive.
 */
export function sandboxShdocHtml(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  // A base tag or meta refresh could redirect the frame; the CSP below blocks
  // the requests anyway, but removing them keeps the intent explicit.
  document
    .querySelectorAll('base, meta[http-equiv="refresh" i]')
    .forEach((node) => node.remove());
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  document.head.prepend(policy);
  if (!document.querySelector('meta[name="viewport"]')) {
    const viewport = document.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width, initial-scale=1";
    document.head.append(viewport);
  }
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

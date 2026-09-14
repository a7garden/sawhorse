import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Reassembles a PDC 정문서 (pdc-html/1 body or djot preview HTML) for script-free
 * reading inside a sandboxed iframe. Extends the shdoc reassembly pattern
 * (features/documents/sandbox.ts) with the managed-asset bridge: `pdc://asset`
 * references are rewritten to `pdc-asset://` webview URLs so images resolve
 * through the registered protocol. The original file is never rewritten — this
 * builds a frame-only copy.
 */
const CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob: pdc-asset: http://pdc-asset.localhost; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const PDC_ASSET_URI = /pdc:\/\/asset\/sha256\/([0-9a-f]{64})/g;

/**
 * convertFileSrc is plain string formatting on desktop but reaches through
 * window.__TAURI_INTERNALS__, which does not exist in the browser preview —
 * there the original pdc:// URI is kept (the CSP above keeps it inert).
 */
function assetUrl(digest: string, spaceId: string | undefined): string | null {
  try {
    const url = convertFileSrc(digest, "pdc-asset");
    return spaceId ? `${url}?space=${encodeURIComponent(spaceId)}` : url;
  } catch {
    return null;
  }
}

export function sandboxPdcHtml(html: string, spaceId: string | undefined): string {
  const dom = new DOMParser().parseFromString(html, "text/html");
  // A base tag or meta refresh could redirect the frame; the CSP below blocks
  // the requests anyway, but removing them keeps the intent explicit.
  dom
    .querySelectorAll('base, meta[http-equiv="refresh" i]')
    .forEach((node) => node.remove());
  dom
    .querySelectorAll("script, iframe, form, object, embed, applet")
    .forEach((node) => node.remove());
  for (const element of Array.from(dom.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "formaction") {
        element.removeAttribute(attribute.name);
      }
    }
  }
  const policy = dom.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = CSP;
  dom.head.prepend(policy);
  if (!dom.querySelector('meta[name="viewport"]')) {
    const viewport = dom.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width, initial-scale=1";
    dom.head.append(viewport);
  }
  // Digest hex cannot carry quoting hazards, so a flat replace over the
  // serialized output is safe and also covers srcset and plain text.
  return `<!doctype html>\n${dom.documentElement.outerHTML}`.replace(
    PDC_ASSET_URI,
    (uri, digest: string) => assetUrl(digest, spaceId) ?? uri,
  );
}

import { ViewPlugin, type EditorView } from "@codemirror/view";
import { api } from "@/lib/api";
import type { IntentAttachment } from "./intent";

export const imageMarkdown = (image: IntentAttachment & { reference: string }) =>
  `![${image.name.replace(/[\[\]\\\r\n]/g, "").slice(0, 160)}](${image.reference})`;

export const embeddedImages = (markdown: string, images: IntentAttachment[]) =>
  images.filter((image) => image.reference && markdown.includes(`(${image.reference})`));

/** Atomic renders Markdown images itself. Resolve vault-relative sources only in
 * its rendered DOM, so the Markdown and undo history retain portable file links. */
export function vaultImageSources(notePath: string) {
  const sources = new Map<string, Promise<string>>();
  return ViewPlugin.fromClass(class {
    observer: MutationObserver;
    seen = new WeakSet<HTMLImageElement>();
    disposed = false;
    constructor(readonly view: EditorView) {
      this.observer = new MutationObserver(() => this.resolve());
      this.observer.observe(view.dom, { childList: true, subtree: true });
      queueMicrotask(() => this.resolve());
    }
    resolve() {
      if (this.disposed) return;
      for (const image of this.view.dom.querySelectorAll<HTMLImageElement>(".cm-atomic-image img")) {
        if (this.seen.has(image)) continue;
        this.seen.add(image);
        const raw = image.getAttribute("src") ?? "";
        const src = raw.replace(/^<|>$/g, "");
        if (/^(https?:|data:|blob:)/i.test(src)) {
          if (src !== raw) image.src = src;
          continue;
        }
        if (!src) continue;
        let source = sources.get(src);
        if (!source) { source = api.readNoteAsset(notePath, src); sources.set(src, source); }
        void source.then((url) => {
          if (this.disposed || !image.isConnected) return;
          image.onload = () => { if (!this.disposed) this.view.requestMeasure(); };
          image.src = url;
        }).catch((error) => {
          if (!this.disposed) image.title = String(error);
          sources.delete(src);
        });
      }
    }
    destroy() { this.disposed = true; this.observer.disconnect(); }
  });
}

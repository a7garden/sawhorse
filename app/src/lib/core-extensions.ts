import { create } from "zustand";
import { api } from "./api";
export const useCoreExtensions = create<{
  feeds: boolean;
  github: boolean;
  githubInstalled: boolean;
  refresh: () => Promise<void>;
  setEnabled: (id: "feeds" | "github", enabled: boolean) => Promise<void>;
}>((set, get) => ({
  feeds: true,
  github: false,
  githubInstalled: false,
  refresh: async () => {
    const { bundles } = await api.extensionsList();
    set({
      feeds: bundles.some(
        (b) =>
          b.enabled !== false &&
          b.manifest.components.some((c) => c.adapter === "builtin:rss"),
      ),
      githubInstalled: bundles.some((b) => b.manifest.id === "github"),
      github: bundles.some(
        (b) =>
          b.enabled !== false &&
          b.manifest.components.some((c) => c.adapter === "builtin:github"),
      ),
    });
  },
  setEnabled: async (id, enabled) => {
    await api.setConnectorEnabled(id, enabled);
    await get().refresh();
  },
}));

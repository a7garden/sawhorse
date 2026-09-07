import { snapshot, documents, todos } from "./seed";

// Documentation-only entry point, excluded from the production Vite build.
// Run on the dedicated showcase origin (port 1430), never on the desktop origin.
if (!import.meta.env.DEV || location.port !== "1430" || location.hostname !== "127.0.0.1"
  || new URLSearchParams(location.search).get("preview") !== "1") {
  throw new Error("Open http://127.0.0.1:1430/showcase/?preview=1 using the Vite development server.");
}

localStorage.setItem("sawhorse.language", "en");
localStorage.setItem("sawhorse.theme", "light");
localStorage.setItem("sawhorse.workflow.preview.v2", JSON.stringify({ snapshot, documents }));
localStorage.setItem("sawhorse.preview-todos", JSON.stringify(todos));
localStorage.setItem("sawhorse.work-view", "board");
localStorage.setItem("sawhorse.project-scope", "");
localStorage.setItem("sawhorse.sidebar-collapsed", "false");
localStorage.removeItem("sawhorse.dashboard-layout");

const { useApp } = await import("../src/lib/store");
const screen = new URLSearchParams(location.search).get("screen");
useApp.getState().setPage(screen === "work" || screen === "calendar" ? screen : "overview");
await import("../src/main");

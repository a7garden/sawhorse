# README screenshots

The images show the real Sawhorse React UI in English, using fictional Atlas,
Compass, and Relay projects. The preview banner remains visible. No agents are
launched and no desktop workspace files are used.

## Recreate the app screens

```bash
cd app
npm ci
npm run dev -- --port 1430
```

Open `http://127.0.0.1:1430/showcase/?preview=1` for the workbench, or append
`&screen=work` for the process board. Select **Design a faster command menu**
and then **spec** for the document screenshot.

The documentation-only entry point in `app/showcase/` sets English, light theme,
and sample data on this dedicated browser origin. Reloading reseeds its demo
data; use this port only for the showcase. Dates are relative to the current day.
The entry point is excluded from the production build and refuses to run on
other origins or outside Vite development mode.

The committed captures use a 1280 × 720 viewport:

- `workbench.png` — project overview, priorities, and deadlines.
- `process-board.png` — the same work across five workflow stages.
- `work-detail.png` — Markdown specification with agent context.

## Recreate the cover

From the repository root, run:

```bash
python3 -m http.server 1431 --bind 127.0.0.1
```

Open `http://127.0.0.1:1431/docs/images/cover.html` and capture the 1280 × 720
viewport as `sawhorse-overview.png`. The HTML uses the app's existing SVG
logo and the unaltered `workbench.png` capture, with English product copy.

```bash
# Validate the app and documentation fixture.
cd app
npm run build
npx tsc --project showcase/tsconfig.json
```

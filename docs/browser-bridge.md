# Browser Bridge — in-app Playwright for the sandbox browser

The bridge lets an AI (or any script) **see and drive the app's own in-app
browser** — the same tabs and `<webview>` guests the user is looking at.
Unlike Playwright there is no browser spawn, no CDP handshake, no separate
profile: commands execute against the live page in a few milliseconds, which
makes debugging and e2e loops fast.

## Architecture

```
agent (in-app)  ──► browser MCP server ──┐
                                          ├─► bridgeDispatch (main.js)
terminal CLI / curl ─► HTTP 127.0.0.1 ───┘        │ 'bridge-cmd' IPC
                                                   ▼
                                    renderer/src/bridge.js  ── executeJavaScript /
                                                               sendInputEvent /
                                                               capturePage
                                                   ▼
                                       sandbox <webview> guests (browser.js tabs)
```

- **main.js** — `bridgeDispatch()`: relays commands to the renderer, serves
  the `network` op itself (passive webRequest log of `persist:sandbox`),
  saves screenshots, hosts the token-gated localhost HTTP endpoint, and
  builds the `browser` MCP server injected into every agent run.
- **renderer/src/bridge.js** — executes each op against the right tab:
  injects a small helper library (`__lv`) into the guest page for
  snapshot/click/fill, uses real Chromium input events for key presses.
- **browser.js** exposes its internals as `window.__bw`; the bridge drives
  the same tabs the user sees (no headless parallel browser).

## Two ways in

### 1. In-app agents (MCP, automatic)

Every agent run gets the `browser` MCP server. Tools:

| tool | purpose |
|---|---|
| `browser_tabs` | list tabs (id, url, title, project, active) |
| `browser_open` | open URL (reuses an existing tab for the same URL) |
| `browser_navigate` | url / back / forward / reload |
| `browser_snapshot` | headings + interactive elements with stable `ref=eN` |
| `browser_click` | click by ref / CSS selector / visible text |
| `browser_fill` | set input value (React-safe native setter), optional submit |
| `browser_press` | real key event (Enter submits forms, `Control+a`, …) |
| `browser_eval` | run JS in the page, JSON result |
| `browser_console` | buffered console messages (errors survive reloads of devtools) |
| `browser_network` | recent requests: method, url, status, ms, errors |
| `browser_screenshot` | PNG to a file path (view with Read) |
| `browser_wait_for` | selector present / text visible / url contains / gone / load |

### 2. Terminal / external Claude Code (HTTP + CLI)

Every in-app terminal has `LOVEAI_BRIDGE_PORT` / `LOVEAI_BRIDGE_TOKEN` in its
env; external processes read `~/.loveai/browser-bridge.json` (rewritten on
every app start). `browserctl.js` at the repo root wraps it:

```bash
node browserctl.js health                        # is the app up?
node browserctl.js open http://localhost:5173    # open dev server
node browserctl.js snapshot                      # page outline with refs
node browserctl.js click e12                     # click ref from snapshot
node browserctl.js click "Sign in"               # or by visible text
node browserctl.js fill css=#email me@x.com --submit
node browserctl.js eval "document.title"
node browserctl.js console --limit 100           # page errors, no devtools
node browserctl.js network --filter /api/
node browserctl.js screenshot                    # prints saved PNG path
node browserctl.js wait --text "Welcome" --timeout 15000
```

Raw HTTP (same thing): `POST http://127.0.0.1:<port>/cmd` with header
`x-bridge-token: <token>` and body `{"op":"snapshot","mode":"interactive"}`.

## The e2e workflow (for AI)

1. `open <url>` — waits for the load to settle.
2. `snapshot` — read the outline, note `ref=eN` ids.
3. `click` / `fill` / `press` — act by ref (best), text, or `css=` selector.
4. `wait` — for the text/selector/url the action should produce.
5. `console` + `network` — assert no errors / check API calls.
6. `screenshot` — visual check when needed.

**Refs reset on navigation** — retake the snapshot after any page change.

## Caveats

- Commands without `tabId` target the **active tab of the active project**.
- A tab in another project can be driven only if its guest is already loaded
  (webviews attach lazily when their project's browser is shown).
- `screenshot` activates the tab first — hidden guests capture blank.
- Same-origin iframes are not walked by `snapshot`; use `eval` for those.
- The HTTP endpoint binds 127.0.0.1 only and requires the per-launch token.
- `eval` runs with the page's own privileges inside the sandboxed guest —
  it cannot reach the app shell or Node.

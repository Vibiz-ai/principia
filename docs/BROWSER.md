# The company browser

Every company in Principia has its own browser. It opens in a panel on the right of a chat or an agent's page.
Agents (Claude, Codex) drive it through the `principia-browser` MCP server; the founder watches, types an address,
or presses **Take over** to drive it themselves while agents wait.

## 1. Why this design

- **One embedded view per company, not a separate browser.** Principia already ships Chromium. A `WebContentsView`
  per tab, on the company's own session (`persist:company-<id>`), keeps cookies, storage, cache and permissions apart
  between companies and from Principia itself.
- **CDP over `webContents.debugger`, never `--remote-debugging-port`.** A global debugging port exposes every web
  contents, Principia's own windows included, to any local process. The debugger here is attached only to the panel's
  views.
- **Our own small MCP server, with the vocabulary agents already know.** The tool names and the ref snapshot follow
  Playwright MCP and agent-browser (`browser_navigate`, `browser_snapshot`, `browser_click` by `ref`). The tools return a
  fresh snapshot after each action, so an agent needs fewer turns. Fewer turns makes a run faster than saving tokens
  with a CLI does.
- **Zenbu's terminal-browser is not used.** It draws Chromium into a terminal through the kitty graphics protocol. Our
  panel is a native Electron surface, so that would add a second browser and decoding work for nothing.

## 2. Architecture

```
agent CLI (claude / codex)
  └─ stdio MCP: out/main/mcp-browser.js  (ELECTRON_RUN_AS_NODE, holds only URL + token)
        └─ POST http://127.0.0.1:<port>/v1/call  {tool, args}  Authorization: Bearer <spawn token>
              └─ main: BrowserService (token → ONE company) → runBrowserTool → CompanyBrowser
                    └─ BrowserHost: company → tabs (WebContentsView + CdpDriver over webContents.debugger)
renderer: <BrowserDock> → <BrowserPanel companyId> ⇄ browser:* IPC (state, bounds, navigate, nav, tab, takeover…)
```

| File | What it does |
|---|---|
| `src/shared/browser.ts` | Types, IPC channels and events, tool definitions, `addressToUrl` |
| `src/main/browser/host.ts` | Sessions, tabs and views, layout, screenshots, downloads, takeover and activity state |
| `src/main/browser/driver.ts` | The CDP driver for one tab: navigate, AX snapshot, click/type/press/select/scroll by ref, waits, console and network buffers |
| `src/main/browser/snapshot.ts` | Turns the accessibility tree into ref lines (pure) |
| `src/main/browser/tools.ts` | The MCP tools against one company's browser; enforces takeover (pure apart from the driver) |
| `src/main/browser/service.ts` | Tokens, the 127.0.0.1 endpoint, and the MCP spec for each spawn |
| `src/main/browser/policy.ts`, `downloads.ts` | URL, permission and download rules (pure) |
| `src/main/browser/mcp/main.ts` | The stdio bridge agents run |
| `src/main/browser/wire.ts`, `schemas.ts` | IPC handlers and their schemas |
| `src/renderer/src/components/browser/*` | `BrowserPanel` (self-contained), `BrowserDock` (right-hand host), `BrowserToggle` |
| `src/renderer/src/state/browser.ts`, `lib/browserDock.ts` | Dock state, when the panel opens by itself |

**Attaching to agents.** The `principia-browser` server is attached in the same per-spawn MCP config as the Forum,
through `attachForum` and `ctx.browser.attachment()`:

- company chats and panes: `engine.providers.interactiveSpawn`;
- task runs and seat runs: `executor.ts`.

On Claude, the tools go into the spawn's `--mcp-config` and `--allowedTools`. On Codex they go in as
`-c mcp_servers.principia-browser.*` overrides with the tools approved. Each spawn gets its own token. When the tools
are attached, the "Use Principia" rules (`principiaOps`) add one line saying the agent has a browser the founder can
watch. Gemini and Cursor are not attached yet: their MCP paths are not verified.

**Mount API.** `<BrowserPanel companyId={id} onClose={fn} />` loads its own data, never takes focus, and reports
where its `.bp-live` box is so main can place the native view there. The dock is only one host for it; the chat
page's right panel can host it the same way.

**Which company.** The open panel always shows the company on screen: the page's own company when the page names one
(its Browser button says so), else the company picked in the rail. Switching company switches the panel; the panel
also shows the company's name beside its tabs.

**Whose tabs.** Every tab belongs to the chat or task that opened it (its scope, `src/main/browser/scopes.ts`):

- `pane:<session id>` for a chat, `task:<task id>` for a board task (the same across its wakes), `run:<run id>` for a
  run with no task, and `founder` for tabs the founder opens from a page that is no chat or task.
- The spawn's token carries the scope (`sessionKey`). `browser_tabs` lists, selects and closes only that scope's tabs,
  and an agent's actions run in its own active tab. Another chat's tab id is "no tab" there.
- The panel shows the tabs of the chat or task on screen. Switching chats switches the panel's tabs with it. An address
  the founder types opens in that chat's tabs, so its agent can use it.
- Take over, the activity line, screenshots and downloads are per scope too.
- Cookies and sign-ins stay per company: a sign-in done once works in every chat of that company.
- At most 12 tabs per scope and 30 per company. Past 30, the tab used longest ago in a chat not on screen closes.

**Room for the page.** The page beside the dock keeps at least 880 px (an agent's page has three columns). The dock
takes what is left, up to the width the founder chose. Too little left: the sidebar steps aside while the dock is open
(nothing is saved; it comes back on close). Still too little: the dock floats over the page's right side.

**Rendering when not on screen.** Agents usually browse while the founder is in another app, or with the panel
closed. Three things keep the page rendering:

- Principia runs with `disable-backgrounding-occluded-windows`, so a covered window keeps drawing.
- A view the panel does not show is moved outside the window, not hidden, and keeps the panel's size.
- A view that has never overlapped the window has a 0x0 page (nothing to click, screenshots hang). Once its first page
  has loaded, and before any agent call that finds it with no size, it is moved over the window's top-left corner pixel
  until the page has a size, then parked again.
- A click the page did not receive is checked for and done from inside the page. A screenshot without a compositor
  frame falls back to CDP `Page.captureScreenshot`.

**Overlays.** A native view draws above the DOM. While a sheet, the palette, a menu or a dialog overlaps the panel, the
view moves aside and the panel says so.

## 3. Tools

| Tool | Arguments | Returns |
|---|---|---|
| `browser_navigate` | `url` (or a bare host), `newTab?` | snapshot |
| `browser_snapshot` | `full?` | ref lines; a big page is written to `<company>/workspace/Browser/snapshots/…md` and the path is returned |
| `browser_click` | `ref`, `element?`, `double?`, `button?` | snapshot |
| `browser_hover` | `ref` | short line |
| `browser_type` | `ref`, `text`, `submit?`, `append?` | short line (snapshot when `submit`) |
| `browser_press` | `key` (Enter, Tab, Escape, ArrowDown, `Control+a`…) | snapshot |
| `browser_select` | `ref`, `values[]` (value or label) | short line |
| `browser_scroll` | `ref?` or `direction`, `pages` | short line |
| `browser_screenshot` | `ref?`, `fullPage?` | path of the PNG in `<company>/workspace/Browser/screenshots/`, plus a JPEG image block (the chat shows it, and so does the panel's strip) |
| `browser_back` / `browser_forward` / `browser_reload` | | snapshot |
| `browser_tabs` | `action` list, new, select or close; `tabId`, `url` | tab list (a new window from a page becomes a tab) |
| `browser_console` | `level?`, `limit?` | recent console lines and page errors |
| `browser_network` | `failed?`, `filter?`, `limit?` | recent requests: method, status, type, url |
| `browser_wait` | `for` load, selector, text or time; `selector` / `text` / `gone` / `seconds` | what happened |

Snapshot format:

```
Page: Sign up test
URL: http://127.0.0.1:8765/form.html
Interactive (7):
- textbox "Full name" value="Ana" [required] [ref=e2] (in form "Sign up")
- combobox "Plan" value="Choose…" [expanded=false] [ref=e4]
- button "Join" [ref=e6]
Content:
- heading "Join the waitlist" [level=1] [ref=e1]
- iframe "Payment" [ref=e9]:
  - note: frame https://pay.example/ not readable (another site, in its own process)
```

- Controls come first, then the outline.
- Refs stay the same for the same element until the page navigates.
- Same-process iframes are read. Cross-process ones are noted.
- JS dialogs never block: alerts are accepted, confirm and prompt dialogs are dismissed, and both are logged to the
  console buffer.

Calls for one chat or task run one at a time; two chats browse side by side.

## 4. Takeover and activity

- **Take over** pauses the agents of the chat or task on screen. Every tool that acts (navigate, click, type, press, select, back, forward, reload,
  opening or closing tabs) returns a plain message telling the agent to wait or ask. Snapshot, screenshot, console,
  network, the tab list and timed waits still work. **Hand back** resumes. A timed `browser_wait` during a takeover
  returns as soon as the founder hands back, so the agent waits instead of ending its turn (its rules line says so).
- Each call sets the activity line in plain words ("Codex is browsing: Clicking “Join”"). The line clears 6 s after the
  last call.
- The panel opens by itself **once per chat or task** when its agent starts browsing, and **only while that chat or
  task is on screen**. An agent browsing in another chat never opens it over the page the founder is on; that chat's
  tabs are waiting when the founder opens it (the panel opens then if the agent is still browsing). It waits
  while the founder is typing in a field, and it never takes focus. Esc closes it (unless a field outside the panel is
  being edited, or a sheet is open).
- `principia://browser[?url=https://…][&company=co_…]` opens the panel, optionally on that page. The **Browser**
  button in the session, agent and task toolbars toggles it, on that chat's or task's tabs.

## 5. Security checklist

- [x] One `persist:company-<id>` partition per company, never the default session. A token is bound to one company,
      and the arguments cannot change which one.
- [x] Panel views: `sandbox`, `contextIsolation`, no preload, `nodeIntegration` off (also in subframes), no
      `<webview>`, DevTools closed if opened (opening them would detach the debugger).
- [x] The debugger is attached only to panel views, and only after the first `about:blank` load. Commands sent
      before the first navigation can hang, so every command also has a 15 s timeout. `detach` is handled: the next
      call re-attaches. No `--remote-debugging-port` in production.
- [x] `setWindowOpenHandler`: a new window becomes a tab in the panel, never a new BrowserWindow.
- [x] Navigation (`will-navigate`, `will-redirect`, `will-frame-navigate`) and every request (`webRequest`) allow only
      http(s), `about:blank`, `data:` and `blob:`, plus ws(s) for requests. These are blocked: `file:`, `chrome:`,
      `devtools:`, `javascript:` and Principia's own origins (the renderer's dev server and the browser, Forum and
      Phone endpoints, under any loopback name).
- [x] Permissions are denied by default (camera, microphone, location, notifications, MIDI, pointer lock,
      fullscreen, devices). Only sanitized clipboard writes are allowed.
- [x] Downloads go to `<company>/workspace/Downloads`:
      - safe file names, never overwritten;
      - a 500 MB cap, checked before and during the download;
      - a file that can run code (`.dmg`, `.app`, `.pkg`, `.command`, `.sh`…) waits for the founder's yes in a dialog.
        It is saved as `Downloads/.waiting/<id>.part` (a small file finishes before the download can be paused), moved
        into place only on yes, and deleted on no.
- [x] The endpoint listens on 127.0.0.1 only and needs `Authorization: Bearer <token>`:
      - each spawn gets its own token;
      - it refuses any request with an `Origin` header, or with a `Host` other than its own loopback address;
      - the body is capped at 256 KB.
- [x] The user agent drops "Electron/…" and the app name, so sites see a normal Chrome.
- [x] **Forget** (`browser:clear`) wipes a company's cookies, storage and cache and closes its tabs.
- [x] Agents are told not to type passwords or card numbers, and not to pay or send anything without the founder's yes.

## 6. Tests

- `src/main/browser/__tests__/snapshot.test.ts`: the ref format, stable refs, wrappers, iframes, truncation.
- `src/main/browser/__tests__/driver.test.ts`, against a fake CDP target:
  - click by ref, and the in-page fallback when the click never arrives;
  - type, select, stale refs;
  - command timeout, load wait, dialogs, console and network buffers, key chords.
- `src/main/browser/__tests__/policy.test.ts`:
  - blocked schemes and origins, permissions, partitions;
  - download names, the size cap, the confirm for files that can run code.
- `src/main/browser/__tests__/service.test.ts`:
  - takeover pauses actions but lets the agent look;
  - screenshots come back as image blocks, big snapshots as a file;
  - a token reaches only its company;
  - HTTP needs a token and refuses `Origin`;
  - one token per spawn, calls for one chat run one at a time, two chats side by side;
  - a token reaches only its own chat's or task's tabs.
- `src/main/browser/__tests__/scopes.test.ts`: tabs and active tab per scope, no tab of another scope, the caps and
  which old tab closes, the scope names the IPC accepts.
- `src/renderer/src/lib/browserDock.test.ts`: when the panel opens by itself (only beside the browsing chat), the dock width, addresses,
  `principia://browser`.
- Live, checked in a separate dev instance with the real `claude` and `codex` CLIs:
  - example.com: opened, read and screenshotted;
  - a local form: filled and submitted, with the panel open and with it closed;
  - `window.open` became a tab, a download landed in the company's folder;
  - cookies and storage stay separate between two companies;
  - Take over and Hand back worked, and the palette pushed the view aside.

## 7. Not yet

- Gemini and Cursor attachment (their MCP config paths are not verified yet).
- An agent-browser-compatible CLI and a CDP proxy scoped to one panel target, for `agent-browser --cdp` or Playwright
  `--cdp-endpoint` (phase 2).
- Cross-process iframes in snapshots (they need per-target sessions); full-page screenshots of very long pages are capped.
- A Settings switch and a "Forget this company's browser data" button (the IPC exists).

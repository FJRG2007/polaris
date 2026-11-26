---
id: VULN-0052
title: An agent's live preview opened in its own desktop window gets the dashboard's desktop bridge
status: fixed
severity: high
cwe: CWE-346
stride: Elevation of Privilege
cvss: "7.6"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:H/A:N
location: clients/desktop/src/main/ipc.ts
component: desktop/bridge
reachability: AUTHENTICATED
exploitability: MODERATE
confidence: 90
discovered: 2026-11-26
last_seen: 2026-11-26
fixed: 2026-11-26
fix_commit: 7e6847b874
---

## Summary
In the desktop app, "Open in new tab" on Polar Code's live preview opened the agent's page in a Polaris window, with the dashboard's preload attached and its main frame accepted by the bridge's check. Whatever the agent served - code from the repository it works in, or a page a prompt injection made it write - could call `window.polarisDesktop` as if it were the dashboard.

## Root cause / data flow
The preview is served on the Polaris's own address (`/api/agents/preview/<session>/<signature>/<port>/`, `dashboard/apps/web/src/lib/agents/session-preview.ts`) with `Content-Security-Policy: sandbox` and no `allow-same-origin`, so in a browser it runs in an opaque origin. In the desktop app, `contain()` (`clients/desktop/src/main/windows.ts`) let any same-origin `window.open` create a Polaris window with `preload/app.js`. `fromPolaris` (`clients/desktop/src/main/ipc.ts`) accepted a sender when it was a Polaris window's main frame whose **URL** was on the Polaris (`isServerUrl(frame.url, origin)`). The opaque origin never entered the check, so the sandbox did not stop it: the URL matched and the call was answered. Inside the dashboard the preview is an iframe, and the main-frame check kept it out; only the popped-out window was exposed.

## Evidence
Read while fixing BUG-0047 (the same window could not be moved or resized). `frame.url` for the preview's top frame is the Polaris's address; `frame.origin` is `"null"`.

## Impact
From a page the agent wrote, after one click by the user, every `fromPolaris` channel answered, among them:
- `hosts.switchTo` / `hosts.edit` / `hosts.remove`: point the app at another server or remove the user's, so the next window loads an address the attacker chose with the full bridge;
- `keyWrap.seal` / `keyWrap.open`: the chat account key's device lock, bound to the sender's URL - which was the Polaris's (opening still needed a sealed blob the opaque origin cannot read from the dashboard's storage);
- `appSettings.*` (shortcuts, relaunch, clipboard history clear), `addons.install` / `uninstall` / `setEnabled`, `installTool`, `openWindow`, `notify`, `pickFolder`, the computer link and VPN calls, `systemIdle`, `runningPrograms`, clipboard read and write.

## Remediation
- `fromPolaris` now requires `isPolarisFrame(frame.url, frame.origin, origin)`: the frame's origin must be the Polaris's, and the page a dashboard screen rather than a route handler (`isDashboardPage`, `clients/desktop/src/main/navigation.ts`).
- A window opened on the Polaris for anything that is not a dashboard screen (`/api`, `/_next`, `/.well-known`, the handlers outside `/api`) is a `page` window: the system's frame and no preload, so no bridge at all (`popupChrome`).
- The update notice and the front-page lookup in `clients/desktop/src/main/index.ts` only address dashboard screens.
- Checked the other windows that load a preload: the launcher (`launcher.ts`) loads only its own file or the instance's `/launcher`, blocks navigation and new windows, and `fromLauncher` checks the top frame's origin and path; the USB worker (`usb-link.ts`) loads only the app's own `usb.html` and blocks navigation and new windows; add-ons create no web contents of their own. None loads a page Polaris does not control.
- Tests: `clients/desktop/test/main/window-chrome.test.ts`.

## History
- 2026-11-26: found and fixed with BUG-0047.

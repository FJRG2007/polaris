/**
 * Polaris's search on any site: Alt+Space (or the keys set in Settings) opens a
 * small launcher over the page that finds what the dashboard's own palette finds
 * and opens it in Polaris.
 *
 * Idle, this is one keydown listener and one storage read. Nothing is drawn, no
 * words are loaded and the worker is not woken until the keys are pressed. The
 * panel itself - the dashboard's own search panel, with React - is a script of
 * its own (`launcher-ui`) that the worker puts into the tab on the first press,
 * so a page pays for this file only. Which sites it runs on is decided by the worker
 * when it registers this script (`syncLauncher`), not here, and the Polaris
 * instance's own origin is never one of them - its own palette answers there.
 *
 * When Polaris Desktop or another launcher (Raycast, PowerToys Run, Flow
 * Launcher) holds Alt+Space system-wide, the OS hands it to that program and
 * this listener never sees it - which is the order wanted ("Desktop first"), with
 * nothing to coordinate. The second key still reaches the page.
 *
 * Drawn in a closed shadow root, like the login menu, so a page can neither
 * restyle nor read it (`launcher-ui`).
 */

import {
    isEditableTarget,
    launcherPress,
    launcherPressAllowed,
    readLauncherSettings,
    type LauncherSettings
} from "@polaris/core/launcher";
import { LAUNCHER_KEY } from "@/lib/launcher-settings";
import type { Reply, Request } from "@/lib/messages";

/** The worker, asked without `askBackground`, whose fallback sentence would
 *  pull the whole catalog into this bundle. */
async function askBackground(request: Request): Promise<Reply> {
    try {
        const reply = (await browser.runtime.sendMessage(request)) as Reply | undefined;
        return reply && typeof reply === "object" && "ok" in reply ? reply : { ok: false, error: "" };
    } catch {
        return { ok: false, error: "" };
    }
}

let settings: LauncherSettings = readLauncherSettings(undefined);

export default defineUnlistedScript({
    main() {
        if (window.top !== window) return;
        const name = LAUNCHER_KEY.slice("local:".length);
        void browser.storage.local
            .get(name)
            .then((held) => (settings = readLauncherSettings(held[name])))
            .catch(() => undefined);
        browser.storage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes[name]) settings = readLauncherSettings(changes[name].newValue);
        });
        window.addEventListener("keydown", onKey, true);
    }
});

function onKey(event: KeyboardEvent): void {
    // A page can dispatch a keydown of its own; only a real press opens this.
    if (!event.isTrusted || !settings.enabled) return;
    const pressed = launcherPress(event, settings.shortcuts);
    if (!pressed) return;
    const apple = /mac|iphone|ipad/i.test(navigator.platform);
    if (!launcherPressAllowed(pressed, { editable: isEditableTarget(event.composedPath()[0]), apple })) return;
    event.preventDefault();
    event.stopPropagation();
    // The panel's own script answers once it is in the page; the first press
    // asks the worker to put it there (it opens as it arrives).
    const toggle = (globalThis as { polarisLauncher?: () => void }).polarisLauncher;
    if (toggle) toggle();
    else void askBackground({ kind: "launcherShow" });
}

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

vi.mock("electron", () => ({ app: { name: "Polaris" }, Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() } }));

import { appItems, type MenuActions } from "@/main/menu";

/**
 * Every place that opens the app's settings - the tray, the app menu - goes
 * through one decision (`settingsRoute`, run by `openSettings`), so none of
 * them can open the bundled page while the host has Settings > This app.
 */
const INDEX = readFileSync(join(__dirname, "..", "..", "src", "main", "index.ts"), "utf8");

function settingsItems(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    return items.flatMap((item) => [
        ...(item.label === "Settings..." ? [item] : []),
        ...(Array.isArray(item.submenu) ? settingsItems(item.submenu) : [])
    ]);
}

/** The text of the function `name` in index.ts, up to the next top-level declaration. */
function body(name: string): string {
    const start = INDEX.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const rest = INDEX.slice(start);
    const end = rest.search(/\n(?:\/\*\*|async function |function |const |let )/);
    return end === -1 ? rest : rest.slice(0, end);
}

describe("settings entry points", () => {
    it("the tray's Settings... asks the one decision", () => {
        const changeServer = vi.fn();
        const actions = new Proxy({ changeServer } as unknown as MenuActions, {
            get: (target, key) => (key in target ? target[key as keyof MenuActions] : vi.fn())
        });
        const items = settingsItems(appItems(actions));
        expect(items).toHaveLength(1);
        expect(items[0]?.click).toBe(changeServer);
    });

    it("the menu action is wired to openSettings, and nothing else opens the settings in place of it", () => {
        expect(INDEX).toMatch(/changeServer: \(\) => void openSettings\(\)/);
        // The bundled page with a settings place and a reason is opened by the
        // decision alone (and by a host page the bundled page itself asked for).
        const withReason = [...INDEX.matchAll(/openConnect\(\{[^}]*reason/g)];
        expect(withReason).toHaveLength(1);
        expect(body("openSettings")).toMatch(/openConnect\(\{[^}]*reason/);
    });

    it("a closed window opens the host's screen in a new one rather than the bundled page", () => {
        const decision = body("openSettings");
        expect(decision).toMatch(/if \(!page\) \{\s*showPolaris\(route\.path\);/);
        expect(decision).not.toMatch(/reason: "offline"/);
    });
});

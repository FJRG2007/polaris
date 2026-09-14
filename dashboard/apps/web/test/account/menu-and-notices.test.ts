/**
 * The menu behind your own face, and the permission Polaris never asked for.
 *
 * **The menu was as wide as the longest thing in it.** A maximum is not a width:
 * a status somebody typed, an address, a "scheduled, until Friday 18:00" each
 * stretched it, so every opening was a different shape and the truncation those
 * spans asked for only happened past the ceiling.
 *
 * **And the apps were hidden.** There is one screen listing every way of having
 * Polaris somewhere else - the desktop app, the browser extension - and it was
 * reachable from Preferences and from the vault's own client screen, which are
 * two places nobody looking for "the Polaris apps" would open.
 *
 * **The browser's permission was only ever asked for mid-alert.** That is the
 * right moment to ask and the wrong moment to find out the answer was no: a
 * browser remembers a refusal for good, and nothing on any screen said Polaris
 * had been refused or what to do about it.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("the menu behind your own face", () => {
    const menu = readFile(`${SRC}components/account-menu.tsx`, "utf8");

    it("is one width rather than a ceiling it grows up to", async () => {
        const source = await menu;
        expect(source).toContain('<DropdownMenuContent align="end" className="w-56">');
        expect(source).not.toContain("max-w-[18rem]");
    });

    it("clips everything in it that somebody can make long", async () => {
        const source = await menu;
        expect(source).toContain(
            '<span className="block truncate text-sm font-medium text-foreground">'
        );
        expect(source).toContain('<span className="min-w-0 flex-1 truncate">');
    });

    it("carries the way to the apps", async () => {
        const source = await menu;
        expect(source).toContain('<Link href="/account/downloads">');
        expect(source).toContain("Get the apps");
    });
});

describe("letting the browser draw a notice", () => {
    const settings = readFile(
        `${SRC}app/(app)/account/notifications/notification-settings-view.tsx`,
        "utf8"
    );

    it("is offered deliberately rather than only mid-alert", async () => {
        const source = await settings;
        expect(source).toContain("function BrowserNoticesCard()");
        expect(source).toContain("void mayNotify()");
    });

    it("says when the browser is the one refusing", async () => {
        const source = await settings;
        expect(source).toContain("This browser is blocking them.");
    });

    it("asks nothing inside the app, which draws its own", async () => {
        const source = await settings;
        expect(source).toContain('if (desktopBridge()) return setStanding("app");');
    });
});

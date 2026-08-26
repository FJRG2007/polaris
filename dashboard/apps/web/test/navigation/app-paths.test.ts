/**
 * Every screen of an app lives under that app's own path.
 *
 * For a while several did not. Management was at /admin but three of its screens
 * answered at /integrations, /settings and /inbox, and Drive's Favorites and
 * Trash sat beside /drive rather than inside it - so the address bar said nothing
 * about which part of Polaris you were in, and the rail only knew where you were
 * because each app carried a hand-written list of the paths that had escaped it.
 * That list is the thing to keep from growing back: a screen added at the top
 * level works, looks finished, and quietly needs an entry in it forever.
 *
 * So the rule is checked rather than remembered. `match` still exists for the one
 * case it is really for - an app that opens on one of its sections instead of its
 * root - and that case has to name a prefix the app's own screens are under.
 */

import { describe, expect, it } from "vitest";
import { APP_SECTIONS, APP_SUBAPPS, POLARIS_APPS, resolveActiveApp } from "@/lib/apps";

/** The prefixes an app answers on, longest first, so a nested one wins. */
function ownedBases(): Array<{ id: string; base: string }> {
    return POLARIS_APPS.flatMap((app) => [app.href, ...(app.match ?? [])].map((base) => ({ id: app.id, base })))
        .sort((left, right) => right.base.length - left.base.length);
}

/** Which app's subtree a path is in, by the paths themselves rather than by the
 *  resolver, so a bug in the resolver cannot make this pass. */
function ownerOf(path: string): string | null {
    const found = ownedBases().find(({ base }) => path === base || path.startsWith(`${base}/`));
    return found?.id ?? null;
}

describe("app paths", () => {
    it("puts every section under the app it belongs to", () => {
        const strays = Object.entries(APP_SECTIONS).flatMap(([app, sections]) =>
            sections.filter((section) => ownerOf(section.href) !== app).map((section) => `${app}: ${section.href}`)
        );
        expect(strays).toEqual([]);
    });

    it("puts every subject under the app it hangs off", () => {
        const strays = APP_SUBAPPS.filter((sub) => sub.parentAppId && ownerOf(sub.base) !== sub.parentAppId).map(
            (sub) => `${sub.parentAppId}: ${sub.base}`
        );
        expect(strays).toEqual([]);
    });

    it("only carries an extra prefix for an app that opens on a section", () => {
        // An app whose href is its own root already owns everything under it.
        // A `match` there is a screen that got out, or a line nobody removed.
        const pointless = POLARIS_APPS.filter((app) => app.match?.some((base) => app.href.startsWith(`${base}/`) === false));
        expect(pointless.map((app) => app.id)).toEqual([]);
    });

    it("resolves each app's own sections back to that app", () => {
        // What the switcher and the rail actually call. The paths being right is
        // half of it; the resolver agreeing is the half somebody sees.
        for (const [app, sections] of Object.entries(APP_SECTIONS)) {
            for (const section of sections) {
                expect([section.href, resolveActiveApp(section.href).id]).toEqual([section.href, app]);
            }
        }
    });
});

/**
 * Nobody opens an app they were not given.
 *
 * The VPN once had no `permission` in the registry, so the switcher listed it to
 * every account and its screens opened for anybody signed in. The menu and the
 * server are two separate answers to the same question, and either one going
 * quiet is the bug. So both halves are checked from the source rather than
 * remembered:
 *
 * - every app in the registry names who may open it, or is on one of the two
 *   short lists below that say why it does not;
 * - every screen under an app's path - in this package and in an app bundle
 *   drawn under that path - refuses somebody who lacks it, on the page itself
 *   or in a layout above it.
 *
 * The check is on the page rather than only the layout because a layout is not
 * drawn again when somebody moves between the screens beneath it, and because
 * several apps lend single things (a door, a game server, a status page) to
 * people who hold none of the app's permissions: those screens check the one
 * thing asked for, which a blanket layout check would turn away.
 */

import { POLARIS_APPS } from "@/lib/apps";
import { describe, expect, it } from "vitest";
import { join, relative, sep } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const WEB = join(__dirname, "..", "..");
const APP_ROUTES = join(WEB, "src", "app", "(app)");
const BUNDLES = join(WEB, "..");

/** Apps open to everyone signed in, by design. */
const OPEN_TO_EVERYONE: Record<string, string> = {
    overview: "a view onto the apps the account can already open",
    account: "the account's own settings"
};

/** Apps with no permission of their own, closed per person by `closes` in
 *  `accessFor` (lib/session.ts) - an audience an administrator chooses. */
const CLOSED_PER_PERSON = ["polar", "vpn"];

/**
 * A call that refuses somebody: a permission, the admin flag, or a check on the
 * one thing the screen is about (a lent door, a shared server). Signing in on
 * its own is not one - `requireUser` is left out on purpose.
 */
const GUARD =
    /\b(require(?!User\b)[A-Z]\w*|sessionCan\w*|userHasManage|resourceAccess|accessOf|polarAccessFor|\w+(?:Reach|Standing))\s*\(/;

/** A screen that only hands the request to another surface, or to a shared
 *  screen that runs the check itself. */
const DELEGATES = /\b(InstalledAppScreen|renderAppPage)\b|^\s*redirect\(/m;

function walk(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        if (entry === "node_modules") return [];
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const read = (path: string) => readFileSync(path, "utf8");
const shown = (path: string) => relative(WEB, path).split(sep).join("/");

/** The first segment of every path an app owns: `/apps/deploy` -> `apps`. */
function appFolders(): Map<string, string> {
    const folders = new Map<string, string>();
    for (const app of POLARIS_APPS) {
        if (app.id in OPEN_TO_EVERYONE) continue;
        for (const base of [app.href, ...(app.match ?? [])]) {
            const folder = base.split("/")[1];
            if (folder) folders.set(folder, app.id);
        }
    }
    return folders;
}

/** Whether a page, or a layout between it and `root`, refuses somebody. */
function guarded(page: string, root: string): boolean {
    const source = read(page);
    if (GUARD.test(source) || DELEGATES.test(source)) return true;
    for (let folder = join(page, ".."); folder.startsWith(root); folder = join(folder, "..")) {
        const layout = join(folder, "layout.tsx");
        if (existsSync(layout) && GUARD.test(read(layout))) return true;
        if (folder === root) break;
    }
    return false;
}

describe("app access", () => {
    it("names who may open every app", () => {
        const unnamed = POLARIS_APPS.filter(
            (app) =>
                !app.permission &&
                !app.adminOnly &&
                !(app.id in OPEN_TO_EVERYONE) &&
                !CLOSED_PER_PERSON.includes(app.id)
        ).map((app) => app.id);
        expect(
            unnamed,
            [
                "Give these apps a `permission` (or `adminOnly`) in POLARIS_APPS (lib/apps.ts).",
                "Without one the switcher lists them to every account. An app closed per",
                "person instead needs a `closes` branch in accessFor (lib/session.ts) and an",
                "entry in CLOSED_PER_PERSON here."
            ].join(" ")
        ).toEqual([]);
    });

    it("closes every app it says is closed per person", () => {
        const session = read(join(WEB, "src", "lib", "session.ts"));
        const closes = session.slice(session.indexOf("closes: async"));
        const missing = CLOSED_PER_PERSON.filter((id) => !closes.includes(`appId === "${id}"`));
        expect(
            missing,
            "accessFor's `closes` (lib/session.ts) must answer for these apps."
        ).toEqual([]);
    });

    it("refuses somebody without access on every screen of every app", () => {
        const offenders = [...appFolders().keys()]
            .map((folder) => join(APP_ROUTES, folder))
            .filter((root) => existsSync(root))
            .flatMap((root) =>
                walk(root)
                    .filter((path) => path.endsWith(`${sep}page.tsx`) && !guarded(path, root))
                    .map(shown)
            );
        expect(
            offenders,
            [
                "These screens draw for anybody signed in. Call requirePermission (or the app's",
                "own guard, or a check on the one thing the screen shows) at the top of the",
                "page, with the permission the app has in POLARIS_APPS."
            ].join(" ")
        ).toEqual([]);
    });

    it("refuses somebody without access on every app bundle screen under an app's path", () => {
        const folders = appFolders();
        const bundles = readdirSync(BUNDLES).filter((name) =>
            existsSync(join(BUNDLES, name, "src", "routes"))
        );
        // The registry cannot drift away from the bundles without this noticing.
        expect(bundles.length).toBeGreaterThan(0);
        const offenders = bundles.flatMap((bundle) => {
            const routes = join(BUNDLES, bundle, "src", "routes");
            return readdirSync(routes)
                .filter((folder) => folders.has(folder))
                .flatMap((folder) =>
                    walk(join(routes, folder))
                        .filter((path) => path.endsWith(`${sep}page.tsx`) && !guarded(path, routes))
                        .map(shown)
                );
        });
        expect(
            offenders,
            [
                "The bundle's page is drawn by renderAppPage, which checks nothing itself: call",
                "the app's guard (host.session.requirePermission or its own require helper) at",
                "the top of these pages."
            ].join(" ")
        ).toEqual([]);
    });
});

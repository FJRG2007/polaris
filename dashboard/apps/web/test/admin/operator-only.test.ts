/**
 * Management is the operator's, and a game server is whoever was given it.
 *
 * The case this holds: a hosting company runs Polaris and its customers run
 * their own game servers on the company's machines. A customer must never reach
 * a screen that lists every server - the Game server ports card on Domains, the
 * billing, the activity log - and must never act on a server, or read one, that
 * nobody gave them.
 *
 * Both are true today because every entry point says so in its first lines, and
 * nothing but convention keeps the next one saying it. So the entry points are
 * read here, as source: every page, route and server action under Management
 * asks for the operator before anything else, and every action on one game
 * server asks about that server. A new one that forgets is a failing test rather
 * than a screen that quietly lists somebody else's servers.
 */

import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const WEB = resolve(__dirname, "../../src/app");
const GAMES = resolve(__dirname, "../../../game-servers/src");

function files(root: string, keep: (path: string) => boolean): string[] {
    const found: string[] = [];
    for (const name of readdirSync(root)) {
        const path = join(root, name);
        if (statSync(path).isDirectory()) found.push(...files(path, keep));
        else if (keep(path)) found.push(path);
    }
    return found.sort();
}

/** Each exported function in a file, with its body up to the next export. */
function exported(source: string): Array<{ name: string; body: string }> {
    const starts = [...source.matchAll(/export (?:async )?function (\w+)\(/g)];
    return starts.map((match, index) => ({
        name: match[1]!,
        body: source.slice(match.index! + match[0].length, starts[index + 1]?.index ?? source.length)
    }));
}

const label = (path: string) => relative(resolve(__dirname, "../../.."), path).replaceAll("\\", "/");

describe("management", () => {
    const admin = join(WEB, "(app)", "admin");

    it("asks for the operator on every page", () => {
        const pages = files(admin, (path) => path.endsWith("page.tsx"));
        expect(pages.length).toBeGreaterThan(20);
        const open = pages.filter((path) => {
            const source = readFileSync(path, "utf8");
            // The shared support inbox is a permission of its own, held by the
            // people who answer it, not by the operator alone.
            return !/\brequireAdmin\(\)|\brequirePermission\("inbox\.read"\)/.test(source);
        });
        expect(open.map(label)).toEqual([]);
    });

    it("asks for the operator in every route", () => {
        const routes = files(join(WEB, "api", "admin"), (path) => path.endsWith("route.ts"));
        expect(routes.length).toBeGreaterThan(10);
        const open = routes.filter((path) => {
            const source = readFileSync(path, "utf8");
            return !/\bapiAdmin\(\)|\.isAdmin\b/.test(source);
        });
        expect(open.map(label)).toEqual([]);
    });

    it("asks for the operator in every server action", () => {
        const actions = files(admin, (path) => /\.ts$/.test(path)).filter((path) =>
            readFileSync(path, "utf8").includes('"use server"')
        );
        const open: string[] = [];
        for (const path of actions) {
            const source = readFileSync(path, "utf8");
            // A file whose actions all go through one guarded helper says so once.
            const helper = /async function scope\(\)[^}]*requireAdmin\(\)/s.test(source);
            for (const action of exported(source)) {
                const guarded =
                    /\brequireAdmin\(\)/.test(action.body) ||
                    /\brequirePermission\("inbox\.(read|manage)"\)/.test(action.body) ||
                    (helper && /\bscope\(\)/.test(action.body));
                if (!guarded) open.push(`${label(path)}: ${action.name}`);
            }
        }
        expect(open).toEqual([]);
    });
});

describe("game servers", () => {
    /**
     * The two that do not ask in their own body, each for a reason that is not
     * an oversight.
     */
    const ASKS_ELSEWHERE = new Set([
        // Turns a pasted URL into a folder name. Reads nothing, writes nothing.
        "suggestFivemResourceNameAction",
        // Hands straight to `invitePlayer`, whose first line asks for
        // games.manage on the server named.
        "invitePlayerAccountAction"
    ]);

    it("asks about the server named in every action on one", () => {
        const actions = files(join(GAMES, "screens"), (path) => /-actions\.ts$|[\\/]actions\.ts$/.test(path));
        expect(actions.length).toBeGreaterThan(10);
        const open: string[] = [];
        for (const path of actions) {
            for (const action of exported(readFileSync(path, "utf8"))) {
                if (ASKS_ELSEWHERE.has(action.name)) continue;
                if (!/\brequire(GameServer|GameServerOwner|Permission|PermissionAny)\(/.test(action.body))
                    open.push(`${label(path)}: ${action.name}`);
            }
        }
        expect(open).toEqual([]);
    });

    it("lists only what the reader was given", () => {
        // Every list of servers a customer can reach is narrowed to the ids they
        // hold, rather than read for the whole instance and filtered on screen.
        for (const route of ["route.ts", "live/route.ts", "stream/route.ts"]) {
            const source = readFileSync(join(GAMES, "routes", "api", "apps", "games", route), "utf8");
            expect(source, route).toMatch(/reachableInstallIds\(user, "games\.read"\)/);
        }
    });

    it("keeps creating a server instance-wide", () => {
        // Being given one server to help run is not an offer to start more of
        // them on somebody else's machine.
        const source = readFileSync(join(GAMES, "screens", "actions.ts"), "utf8");
        for (const name of ["createGameServerAction", "gameSetupAction", "gameMachinesAction"]) {
            const action = exported(source).find((entry) => entry.name === name);
            expect(action?.body, name).toMatch(/requirePermission\("games\.manage"\)/);
        }
    });
});

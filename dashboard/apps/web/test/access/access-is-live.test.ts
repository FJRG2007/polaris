/**
 * Being granted an app, and being told.
 *
 * Every app in the switcher, every entry in the rail and every screen behind
 * them is resolved on the server from the permissions the reader holds. So
 * granting somebody Mail, or taking Deploy back off them, changed nothing on
 * the screen they were looking at: the switcher went on offering exactly what it
 * offered when the page was rendered. The only way out was a reload, and nobody
 * reloads a page they were never told had changed - least of all the person who
 * does not know an administrator just did something.
 *
 * So a write that moves somebody's access says so, an open tab is woken, and the
 * answer to being woken is to ask the server for the page again. What is
 * asserted here is that shape, and the two rules that keep it honest: a frame
 * carries nothing but the fact that something moved, and every write that can
 * change what a person reaches raises one.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { concerns } from "@/lib/access-live";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("who a change is delivered to", () => {
    it("reaches the person it names", () => {
        expect(concerns({ userIds: ["ana"] }, "ana")).toBe(true);
    });

    it("does not reach anybody else", () => {
        expect(concerns({ userIds: ["ana"] }, "ben")).toBe(false);
    });

    it("reaches everybody when it names nobody", () => {
        // A role rewritten, a policy changed, an app installed: working out who
        // that is is a query per write and a chance to be wrong, and the cost of
        // being broad is a redraw of a page that already looks the way it will.
        expect(concerns({}, "ben")).toBe(true);
        expect(concerns({ userIds: [] }, "ben")).toBe(true);
    });
});

describe("what travels", () => {
    it("is the fact that something moved, and nothing else", async () => {
        // A frame that named the permission would be telling a browser something
        // the server has not agreed to show it yet. The tab answers by asking for
        // the page, which resolves what it may see exactly as the first render
        // did.
        const route = await readFile(`${SRC}app/api/access/stream/route.ts`, "utf8");
        expect(route).toContain('JSON.stringify({ kind: "access", seq: sequence })');
        expect(route).toContain("if (closed || !concerns(change, readerId)) return;");
    });

    it("is refused to anybody without a session", async () => {
        const route = await readFile(`${SRC}app/api/access/stream/route.ts`, "utf8");
        expect(route).toContain('if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });');
    });

    it("is coalesced, because moving somebody between roles is several writes", async () => {
        const route = await readFile(`${SRC}app/api/access/stream/route.ts`, "utf8");
        expect(route).toMatch(/const COALESCE_MS = \d+;/);
    });
});

describe("what a woken tab does", () => {
    it("asks the server for the page again", async () => {
        const watcher = await readFile(`${SRC}components/access-watcher.tsx`, "utf8");
        expect(watcher).toContain("router.refresh()");
        // Through the shared channel, so six tabs cost one connection.
        expect(watcher).toContain("subscribeSharedStream(STREAM_PATH, scope");
    });

    it("ignores a frame it does not understand", async () => {
        // A tab left open across a deploy is talking to a server that has moved
        // on, and an unknown frame must not become a redraw loop.
        const watcher = await readFile(`${SRC}components/access-watcher.tsx`, "utf8");
        expect(watcher).toContain('if (kind !== "access") return;');
    });

    it("is mounted above every screen, which is where the switcher is", async () => {
        const chrome = await readFile(`${SRC}components/app-chrome.tsx`, "utf8");
        expect(chrome).toContain("<AccessWatcher />");
    });
});

describe("every write that moves what somebody reaches raises one", () => {
    /** The file, and what has to be raised from it. */
    const SITES: readonly (readonly [string, readonly string[]])[] = [
        // One person, named: their role, their administrator flag, their account
        // being shut or opened again.
        [
            "app/(app)/admin/users/actions.ts",
            ["setUserRole(admin.id", "setAdminAccess(admin.id", "banUser(admin.id", "unbanUser(admin.id"]
        ],
        // Everybody holding the role, or attached to the policy.
        ["app/(app)/admin/roles/actions.ts", ["setRolePermissions(admin.id", "deleteRole(admin.id"]],
        ["app/(app)/admin/policies/actions.ts", ["attachPolicy(", "detachPolicy(", "deletePolicy(", "updatePolicy("]],
        ["app/(app)/admin/groups/actions.ts", ["addGroupMember(", "removeGroupMember(", "deleteGroup("]],
        // A thing lent to somebody can hand them a whole app - a door opens
        // Places, a game server opens Game servers.
        ["app/(app)/access-actions.ts", ["writeGrant(", "removeGrant("]],
        // And an app that only exists once somebody installs it.
        ["lib/apps/install-service.ts", ["invalidateInstallPresence(app.id)", "invalidateInstallPresence(row.catalogId)"]]
    ];

    for (const [file, writes] of SITES) {
        it(`is raised in ${file}`, async () => {
            const source = await readFile(`${SRC}${file}`, "utf8");
            expect(source, "publishes at all").toContain("publishAccessChange");
            for (const write of writes) {
                const at = source.indexOf(write);
                expect(at, `${file} still calls ${write}`).toBeGreaterThan(0);
                // Raised after the write, not before it: a frame that arrives
                // first is a tab asking for a page the change has not reached.
                const after = source.slice(at);
                const raised = after.indexOf("publishAccessChange");
                expect(raised, `${write} is followed by a publish`).toBeGreaterThan(0);
            }
        });
    }
});

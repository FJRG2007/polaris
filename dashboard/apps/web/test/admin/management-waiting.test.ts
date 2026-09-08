/**
 * The badge on Management.
 *
 * Chat and Mail both put a number on their entry in the switcher, so somebody
 * working in Deploy is told a message arrived. Management had none: a reported
 * message sat in a queue and an update sat published, and the only way to learn
 * of either was to remember to open the screen.
 *
 * Two rules are worth asserting. The first is when an update counts as work: a
 * deployment that installs its own updates at three in the morning has nothing
 * for a person to do, and a number that disappears overnight teaches whoever
 * sees it to ignore the next one. The second is what the badge is called out
 * loud, because every one of them used to say "unread messages" - which would
 * describe a reported message and a published build as post.
 *
 * The wiring itself is asserted against the source: what matters is that the
 * count reaches the one list every badge in Polaris reads, rather than that a
 * mock was called.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { updateIsWaiting } from "@/lib/admin-waiting";
import { waitingSays } from "@/lib/notification-badge";

const SRC = new URL("../../src/", import.meta.url);

describe("an update that is waiting for somebody", () => {
    const OFF = { running: "abc1234def", announced: "9f8e7d6", autoUpdate: "off" };

    it("counts when a published build is not the one running and nothing will install it", () => {
        expect(updateIsWaiting(OFF)).toBe(true);
    });

    it("does not count once the deployment is running that build", () => {
        // The announcement is short and the running sha is not, so it is a
        // prefix. This is also what clears the badge with nothing to clear: the
        // answer becomes no by itself when the update installs.
        expect(updateIsWaiting({ ...OFF, announced: "abc1234" })).toBe(false);
    });

    it("does not count when the deployment installs its own", () => {
        expect(updateIsWaiting({ ...OFF, autoUpdate: "daily" })).toBe(false);
        expect(updateIsWaiting({ ...OFF, autoUpdate: "immediate" })).toBe(false);
    });

    it("says nothing on a build that has no sha, which is every development one", () => {
        expect(updateIsWaiting({ ...OFF, running: null })).toBe(false);
        expect(updateIsWaiting({ ...OFF, announced: null })).toBe(false);
    });
});

describe("what a badge says it is counting", () => {
    it("is messages for an app that does not say otherwise", () => {
        expect(waitingSays(1)).toBe("1 unread message");
        expect(waitingSays(4)).toBe("4 unread messages");
    });

    it("is whatever the app says, for one that does", () => {
        const words = { one: "thing needs an administrator", many: "things need an administrator" };
        expect(waitingSays(1, words)).toBe("1 thing needs an administrator");
        expect(waitingSays(3, words)).toBe("3 things need an administrator");
    });
});

describe("the count reaching every badge in Polaris", () => {
    it("is folded into the one list they all read", async () => {
        // Not named again anywhere downstream: the switcher, its dot, the rail
        // and the tab icon all read this, which is the whole reason it exists.
        const unread = await readFile(new URL("components/app-unread.tsx", SRC), "utf8");
        expect(unread).toContain("useAdminWaiting");
        expect(unread).toContain("admin: admin.total");
    });

    it("is seeded on the server, so the badge is right on the first paint", async () => {
        const chrome = await readFile(new URL("components/app-chrome.tsx", SRC), "utf8");
        expect(chrome).toContain("countAdminWaiting()");
        // And asked for nobody else: two queries per page load for a badge that
        // cannot appear is two queries for nothing.
        expect(chrome).toContain("user.isAdmin\n        ? await countAdminWaiting()");
        expect(chrome).toContain("<AdminWaitingProvider initial={adminWaiting} enabled={user.isAdmin}>");
    });

    it("counts what is open rather than what is unread", async () => {
        // A report somebody has read and not settled is still a report, and a
        // badge that cleared on being looked at would say an empty queue while it
        // was full.
        const waiting = await readFile(new URL("lib/admin-waiting.ts", SRC), "utf8");
        expect(waiting).toContain('prisma.chatReport.count({ where: { status: "open" } })');
        expect(waiting).toContain('prisma.safetyCase.count({ where: { status: "open" } })');
    });

    it("tells the administrators when a message is reported", async () => {
        // It used to be filed in silence - the row appeared under /admin/safety
        // and nothing was said to anybody, which is a queue nobody is queued to.
        const reports = await readFile(new URL("lib/chat/reports.ts", SRC), "utf8");
        // From the leaf module both queues raise it through, rather than by
        // reaching into the safety queue - which would drag that whole module,
        // the audit service and the session layer into everything that imports a
        // report.
        expect(reports).toContain('from "@/lib/notifications/admins"');
        expect(reports).toContain("await alertAdmins({");
        expect(reports).toContain("actionRequired: true");
        // Once, when the queue stops being empty. The alert reaches every
        // administrator by every route they have left on, so one per report turns
        // a spam wave into a hundred alerts each - the badge counts the rest.
        // Claimed rather than counted: a count taken after the write makes both
        // of two simultaneous reports the second one, and neither says anything.
        expect(reports).toContain("if (await claimQueueAnnouncement()) {");
        // And never on a re-report, which updates the row it already has.
        const again = reports.slice(
            reports.indexOf("if (existing) {"),
            reports.indexOf("const made = await prisma.chatReport.create")
        );
        expect(again).not.toContain("alertAdmins");
    });
});

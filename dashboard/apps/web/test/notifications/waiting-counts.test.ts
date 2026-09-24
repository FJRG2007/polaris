/**
 * Something waiting, counted once and shown where it belongs.
 *
 * Two reports: the tab icon counted a waiting update twice, because it is both
 * a notification and Management's count; and inside Management the count sat
 * on Overview instead of on "Update & settings".
 */

import { describe, expect, it } from "vitest";
import { railCount, tabWaiting } from "@/lib/waiting-counts";

const queue = (over: Partial<{ reports: number; cases: number; update: boolean }> = {}) => ({
    reports: 0,
    cases: 0,
    update: false,
    ...over
});
const row = (type: string, read = false) => ({ type, read });

describe("the tab icon", () => {
    it("counts a waiting update once, though the bell and Management both hold it", () => {
        expect(
            tabWaiting({
                bell: [row("system.update")],
                apps: { admin: 1, chat: 0 },
                admin: queue({ update: true })
            })
        ).toBe(1);
    });

    it("counts a report once too, and still adds what only one of them holds", () => {
        expect(
            tabWaiting({
                bell: [row("admin.safety.case"), row("deploy.failed")],
                apps: { admin: 3, chat: 2 },
                admin: queue({ reports: 2, cases: 1 })
            })
        ).toBe(
            // 2 bell + 3 admin + 2 chat, less the one report the bell also holds.
            6
        );
    });

    it("keeps Management's count once the notification about it was read", () => {
        expect(
            tabWaiting({
                bell: [row("system.update", true)],
                apps: { admin: 1 },
                admin: queue({ update: true })
            })
        ).toBe(1);
    });
});

describe("where a count sits in the rail", () => {
    const waiting = { admin: 3, chat: 5 };
    const admin = queue({ update: true, reports: 1, cases: 1 });

    it("puts the whole app's count on the app, in the list of apps", () => {
        expect(railCount({ href: "/admin", appId: "admin", inApp: false, waiting, admin })).toBe(3);
    });

    it("puts the update on Update & settings and the reports on Safety, not on Overview", () => {
        expect(railCount({ href: "/admin", appId: "admin", inApp: true, waiting, admin })).toBe(0);
        expect(railCount({ href: "/admin/settings", appId: "", inApp: true, waiting, admin })).toBe(
            1
        );
        expect(railCount({ href: "/admin/safety", appId: "", inApp: true, waiting, admin })).toBe(
            2
        );
    });

    it("leaves other apps' rails as they were", () => {
        expect(railCount({ href: "/chat", appId: "chat", inApp: true, waiting, admin })).toBe(5);
    });
});

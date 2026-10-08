/**
 * What the app menu lists as waiting, and what a mark does to it before the
 * server answers: the entry goes, its count comes off the group and the badge,
 * and only what cannot be dismissed survives "mark all".
 */

import { describe, expect, it } from "vitest";
import {
    badgeDelta,
    clipText,
    LAUNCHER_TEXT_MAX,
    launcherWaitingSchema,
    markLauncherReadSchema,
    withoutApp,
    withoutItem,
    type LauncherWaiting
} from "@/lib/launcher-waiting";

const waiting: LauncherWaiting = {
    groups: [
        {
            app: "chat",
            total: 7,
            items: [
                {
                    id: "a",
                    title: "Ada",
                    detail: "",
                    href: "/chat/c/a",
                    count: 5,
                    dismissable: true
                },
                {
                    id: "b",
                    title: "Ops",
                    detail: "",
                    href: "/chat/c/b",
                    count: 2,
                    dismissable: true
                }
            ]
        },
        {
            app: "admin",
            total: 4,
            items: [
                {
                    id: "reports",
                    title: "",
                    detail: "",
                    href: "/admin/safety",
                    count: 3,
                    dismissable: true
                },
                {
                    id: "apis",
                    title: "",
                    detail: "",
                    href: "/admin/integrations",
                    count: 1,
                    dismissable: false
                }
            ]
        }
    ]
};

describe("marking one entry read", () => {
    it("takes the entry and its count off its group", () => {
        const after = withoutItem(waiting, "chat", "a");
        expect(after.groups[0]).toMatchObject({ total: 2, items: [{ id: "b" }] });
        expect(badgeDelta(waiting, after, "chat")).toBe(-5);
    });

    it("drops a group left with nothing", () => {
        const after = withoutItem(withoutItem(waiting, "chat", "a"), "chat", "b");
        expect(after.groups.map((group) => group.app)).toEqual(["admin"]);
        expect(badgeDelta(waiting, after, "chat")).toBe(-7);
    });

    it("leaves the menu alone for an entry it does not list", () => {
        expect(withoutItem(waiting, "chat", "zzz")).toEqual(waiting);
        expect(withoutItem(waiting, "mail", "a")).toEqual(waiting);
    });
});

describe("marking a whole app read", () => {
    it("keeps only what cannot be dismissed", () => {
        const after = withoutApp(waiting, "admin");
        expect(after.groups[1]).toMatchObject({ total: 1, items: [{ id: "apis" }] });
        expect(badgeDelta(waiting, after, "admin")).toBe(-3);
    });

    it("drops the group when everything could be", () => {
        expect(withoutApp(waiting, "chat").groups.map((group) => group.app)).toEqual(["admin"]);
    });
});

describe("the shapes both ends check", () => {
    it("accepts an entry or an app, and nothing else", () => {
        expect(
            markLauncherReadSchema.safeParse({ scope: "item", app: "mail", id: "t1" }).success
        ).toBe(true);
        expect(markLauncherReadSchema.safeParse({ scope: "app", app: "admin" }).success).toBe(true);
        expect(markLauncherReadSchema.safeParse({ scope: "item", app: "mail" }).success).toBe(
            false
        );
        expect(markLauncherReadSchema.safeParse({ scope: "app", app: "drive" }).success).toBe(
            false
        );
    });

    it("cuts text to what an entry carries, never through a character", () => {
        expect(clipText("Invoice")).toBe("Invoice");
        expect(clipText("x".repeat(LAUNCHER_TEXT_MAX + 1))).toHaveLength(LAUNCHER_TEXT_MAX);
        const split = `${"x".repeat(LAUNCHER_TEXT_MAX - 1)}\u{1F600}`;
        expect(clipText(split)).toBe("x".repeat(LAUNCHER_TEXT_MAX - 1));
    });

    it("refuses a link that leaves Polaris", () => {
        const bad = structuredClone(waiting) as { groups: { items: { href: string }[] }[] };
        bad.groups[0]!.items[0]!.href = "https://example.test/";
        expect(launcherWaitingSchema.safeParse(bad).success).toBe(false);
        expect(launcherWaitingSchema.safeParse(waiting).success).toBe(true);
    });
});

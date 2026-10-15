/**
 * A Management badge that clears once its screen has been opened.
 *
 * By default, opening the Update screen stops the waiting update counting and
 * opening Safety stops the reports and cases already there counting - until a
 * newer build or a newer report arrives, which counts again. An account that
 * turned that off keeps the badge until the work is done.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let clearOnVisit: boolean | null = null;
let marks: { key: string; mark: string }[] = [];
let written: { key: string; mark: string }[] = [];
let countedSince: (Date | undefined)[] = [];

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_BUILD_SHA: "running123" }) }));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => "new4567 2026-09-29T10:00:00Z" }));
vi.mock("@/lib/update-watcher", () => ({ getAutoUpdatePolicy: async () => ({ mode: "off" }) }));

const count = async ({ where }: { where: { createdAt?: { gt: Date } } }) => {
    countedSince.push(where.createdAt?.gt);
    return where.createdAt ? 1 : 3;
};

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: async () => ({ badgesClearOnVisit: clearOnVisit }) },
        userBadgeSeen: {
            findMany: async () => marks,
            upsert: async ({ create }: { create: { key: string; mark: string } }) => {
                written.push({ key: create.key, mark: create.mark });
                return {};
            }
        },
        chatReport: { count },
        safetyCase: { count }
    }
}));

const { adminWaiting, apiOffMarks, dismissAdminWaiting, markScreenSeen, unseenApisOff } =
    await import("@/lib/admin-waiting");
const { clearsOnVisit, isBadgeScreen } = await import("@/lib/badge-seen");

beforeEach(() => {
    clearOnVisit = null;
    marks = [];
    written = [];
    countedSince = [];
});

describe("before the screen has been opened", () => {
    it("counts the update and every open report and case", async () => {
        expect(await adminWaiting("ada")).toEqual({
            reports: 3,
            cases: 3,
            update: true,
            apis: 0,
            total: 7
        });
    });
});

describe("after opening the screens, by default", () => {
    it("stops counting the update that was shown", async () => {
        marks = [{ key: "admin.update", mark: "new4567" }];
        expect((await adminWaiting("ada")).update).toBe(false);
    });

    it("counts a newer build again", async () => {
        marks = [{ key: "admin.update", mark: "old0001" }];
        expect((await adminWaiting("ada")).update).toBe(true);
    });

    it("counts only the reports and cases newer than the visit", async () => {
        marks = [{ key: "admin.safety", mark: "2026-09-29T09:00:00.000Z" }];
        const waiting = await adminWaiting("ada");
        expect(countedSince.map((at) => at?.toISOString())).toEqual([
            "2026-09-29T09:00:00.000Z",
            "2026-09-29T09:00:00.000Z"
        ]);
        expect(waiting).toMatchObject({ reports: 1, cases: 1 });
    });
});

describe("an account that keeps its badges", () => {
    it("counts everything whatever it has opened", async () => {
        clearOnVisit = false;
        marks = [
            { key: "admin.update", mark: "new4567" },
            { key: "admin.safety", mark: "2026-09-29T09:00:00.000Z" }
        ];
        expect(await adminWaiting("ada")).toEqual({
            reports: 3,
            cases: 3,
            update: true,
            apis: 0,
            total: 7
        });
    });
});

describe("opening a screen", () => {
    it("remembers the build the Update screen showed", async () => {
        await markScreenSeen("ada", "/admin/settings");
        expect(written).toEqual([{ key: "admin.update", mark: "new4567" }]);
    });

    it("remembers when Safety was opened", async () => {
        await markScreenSeen("ada", "/admin/safety");
        expect(written[0]?.key).toBe("admin.safety");
        expect(Number.isNaN(new Date(written[0]!.mark).getTime())).toBe(false);
    });

    it("accepts only the screens that carry such a badge", () => {
        expect(isBadgeScreen("/admin/safety")).toBe(true);
        expect(isBadgeScreen("/admin/users")).toBe(false);
        expect(isBadgeScreen("toString")).toBe(false);
    });

    it("clears on a visit unless the account said otherwise", () => {
        expect(clearsOnVisit(null)).toBe(true);
        expect(clearsOnVisit(false)).toBe(false);
    });
});

describe("marking entries seen from the app menu", () => {
    it("is honoured even for an account that keeps its badges", async () => {
        clearOnVisit = false;
        marks = [
            { key: "dismissed.admin.update", mark: "new4567" },
            { key: "dismissed.admin.reports", mark: "2026-09-29T09:00:00.000Z" }
        ];
        const waiting = await adminWaiting("ada");
        expect(countedSince.map((at) => at?.toISOString())).toEqual([
            "2026-09-29T09:00:00.000Z",
            undefined
        ]);
        expect(waiting).toEqual({ reports: 1, cases: 3, update: false, apis: 0, total: 4 });
    });

    it("takes the later of a visit and a mark", async () => {
        marks = [
            { key: "admin.safety", mark: "2026-09-29T09:00:00.000Z" },
            { key: "dismissed.admin.cases", mark: "2026-09-30T09:00:00.000Z" }
        ];
        await adminWaiting("ada");
        expect(countedSince.map((at) => at?.toISOString())).toEqual([
            "2026-09-29T09:00:00.000Z",
            "2026-09-30T09:00:00.000Z"
        ]);
    });

    it("writes the build for the update, a moment for each queue, and the APIs off now", async () => {
        await dismissAdminWaiting("ada", ["update", "reports", "apis", "reports"]);
        expect(written.map((row) => row.key)).toEqual([
            "dismissed.admin.update",
            "dismissed.admin.reports",
            "dismissed.admin.apis"
        ]);
        expect(written[0]?.mark).toBe("new4567");
    });
});

describe("switched-off APIs marked seen", () => {
    const off = (since: string) =>
        JSON.stringify({
            state: "disabled",
            project: "1",
            activationUrl: null,
            since,
            checkedAt: since
        });
    const on = JSON.stringify({
        state: "enabled",
        project: null,
        activationUrl: null,
        since: "2026-10-01T00:00:00.000Z",
        checkedAt: "2026-10-01T00:00:00.000Z"
    });

    it("marks each API that is off by when it went off", () => {
        expect(
            apiOffMarks([
                { id: "drive", raw: off("2026-10-15T15:58:17.429Z") },
                { id: "calendar", raw: on },
                { id: "tasks", raw: null }
            ])
        ).toEqual(["drive@2026-10-15T15:58:17.429Z"]);
    });

    it("stops counting what was seen, and counts it again once it goes off anew", () => {
        const seen = "drive@2026-10-15T15:58:17.429Z";
        expect(unseenApisOff(["drive@2026-10-15T15:58:17.429Z"], undefined)).toBe(1);
        expect(unseenApisOff(["drive@2026-10-15T15:58:17.429Z"], seen)).toBe(0);
        expect(unseenApisOff(["drive@2026-10-20T08:00:00.000Z"], seen)).toBe(1);
        expect(
            unseenApisOff(
                ["drive@2026-10-15T15:58:17.429Z", "tasks@2026-10-16T00:00:00.000Z"],
                seen
            )
        ).toBe(1);
    });
});

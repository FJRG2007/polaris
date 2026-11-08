/**
 * The seasonal calendar an admin edits, end to end on the server: only an
 * administrator saves a season or starts a preview, a rule is checked against
 * the shared schema and the rest of the calendar, what is stored is only what
 * differs from the defaults, and a preview belongs to the session that set it.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

let admin = true;
const settings = new Map<string, string>();
const jar = new Map<string, string>();

vi.mock("@/lib/session", () => ({
    requireAdmin: async () => {
        if (!admin) throw new Error("NEXT_REDIRECT");
        return { id: "admin", isAdmin: true, sessionId: "session-a" };
    },
    requireUser: async () => ({ id: "admin", isAdmin: admin, sessionId: "session-a" })
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));
vi.mock("next/headers", () => ({
    headers: async () => new Headers({ "x-forwarded-proto": "https" }),
    cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name)
    })
}));
// `cache` memoizes per request; each call here is its own request.
vi.mock("react", async (original) => ({
    ...(await original<typeof import("react")>()),
    cache: <T>(fn: T) => fn
}));

const actions = await import("@/app/(app)/admin/settings/seasonal-actions");
const service = await import("@/lib/seasonal-service");
const preview = await import("@/lib/seasonal-preview");

const md = (month: number, day: number) => ({ month, day });

beforeEach(() => {
    admin = true;
    settings.clear();
    jar.clear();
});

describe("saving a season", () => {
    it("moves a season's dates for everybody, and the resolver reads them back", async () => {
        const result = await actions.saveSeasonRuleAction("halloween", {
            enabled: true,
            from: md(10, 20),
            to: md(11, 1)
        });
        expect(result.error).toBeUndefined();
        const calendar = await service.seasonCalendar();
        expect(calendar.halloween.window).toEqual({ from: md(10, 20), to: md(11, 1) });
        expect(core.seasonOn(new Date(2026, 9, 10, 12), calendar)).toBeNull();
        expect(core.seasonOn(new Date(2026, 9, 25, 12), calendar)).toBe("halloween");
    });

    it("forgets a season put back to its defaults, so nothing is stored", async () => {
        await actions.saveSeasonRuleAction("winter", { enabled: false, from: md(12, 1), to: md(1, 9) });
        expect(JSON.parse(settings.get("seasonal.calendar")!)).toEqual({ winter: { enabled: false } });
        await actions.saveSeasonRuleAction("winter", { enabled: true, from: md(12, 1), to: md(1, 9) });
        expect(settings.has("seasonal.calendar")).toBe(false);
        expect(await service.seasonCalendar()).toEqual(core.DEFAULT_SEASON_CALENDAR);
    });

    it("refuses a day its month does not have, naming the field", async () => {
        const result = await actions.saveSeasonRuleAction("halloween", {
            enabled: true,
            from: md(9, 31),
            to: md(10, 2)
        });
        expect(result).toEqual({ error: "settings.seasonal.dayOutOfMonth", field: "from" });
        expect(settings.size).toBe(0);
    });

    it("refuses dates that run into another season, and names it", async () => {
        const result = await actions.saveSeasonRuleAction("halloween", {
            enabled: true,
            from: md(10, 7),
            to: md(12, 5)
        });
        expect(result.error).toContain("settings.seasonal.overlaps");
        expect(result.error).toContain("season.winter");
        expect(settings.size).toBe(0);
    });

    it("refuses an unknown season and a malformed rule", async () => {
        expect((await actions.saveSeasonRuleAction("easter", {})).error).toBe(
            "settings.seasonal.notSaved"
        );
        expect((await actions.saveSeasonRuleAction("winter", { enabled: true })).error).toBe(
            "settings.seasonal.notSaved"
        );
    });

    it("refuses somebody who is not an administrator", async () => {
        admin = false;
        await expect(
            actions.saveSeasonRuleAction("halloween", { enabled: false, from: md(10, 7), to: md(11, 2) })
        ).rejects.toThrow();
        expect(settings.size).toBe(0);
    });
});

describe("previewing a season", () => {
    it("is kept for the session that set it alone", async () => {
        expect(await actions.previewSeasonAction("lunarNewYear")).toEqual({});
        expect(await preview.seasonPreviewFor("session-a")).toBe("lunarNewYear");
        expect(await preview.seasonPreviewFor("session-b")).toBeNull();
        expect(await preview.seasonPreviewFor(null)).toBeNull();
    });

    it("stops", async () => {
        await actions.previewSeasonAction("halloween");
        expect(await actions.stopSeasonPreviewAction()).toEqual({});
        expect(await preview.seasonPreviewFor("session-a")).toBeNull();
    });

    it("refuses an unknown season and somebody who is not an administrator", async () => {
        expect((await actions.previewSeasonAction("easter")).error).toBe(
            "settings.seasonal.previewFailed"
        );
        admin = false;
        await expect(actions.previewSeasonAction("halloween")).rejects.toThrow();
        expect(jar.size).toBe(0);
    });

    it("reads nothing from a cookie that is not this session's or names no season", () => {
        expect(preview.readSeasonPreview("session-a:winter", "session-a")).toBe("winter");
        expect(preview.readSeasonPreview("session-a:winter", "session-b")).toBeNull();
        expect(preview.readSeasonPreview("session-a:easter", "session-a")).toBeNull();
        expect(preview.readSeasonPreview(":winter", "")).toBeNull();
        expect(preview.readSeasonPreview(undefined, "session-a")).toBeNull();
    });
});

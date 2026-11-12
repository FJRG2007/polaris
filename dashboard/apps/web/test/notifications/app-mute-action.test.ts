/**
 * The app menu's mute: validated, refused for an app with nothing to mute, and
 * timed on the server's clock whatever the browser sends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationHolds } from "@polaris/core";

const state = vi.hoisted(() => ({
    holds: { mutes: {}, schedules: {} } as NotificationHolds,
    writes: 0
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "alice" }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/app-launcher-service", () => ({
    getLauncherPrefs: vi.fn(),
    saveLauncherPrefs: vi.fn()
}));
vi.mock("@/lib/app-lock-service", () => ({ setAppLock: vi.fn() }));
vi.mock("@/lib/notifications/preferences", () => ({
    updateNotificationHolds: async (
        _userId: string,
        change: (holds: NotificationHolds) => NotificationHolds
    ) => {
        state.writes += 1;
        state.holds = change(state.holds);
        return state.holds;
    }
}));

const { setAppMuteAction } = await import("@/app/(app)/app-launcher-actions");

beforeEach(() => {
    state.holds = { mutes: {}, schedules: {} };
    state.writes = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T10:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe("setAppMuteAction", () => {
    it("mutes for the chosen span, ending on the server's clock", async () => {
        const answer = await setAppMuteAction({ appId: "mail", duration: "8h" });
        expect(answer.error).toBeUndefined();
        expect(answer.holds?.mutes).toEqual({
            "group:mail": { until: "2026-11-12T18:00:00.000Z" }
        });
    });

    it("mutes Chat under its own hold, and lifts it", async () => {
        await setAppMuteAction({ appId: "chat", duration: "1w" });
        expect(state.holds.mutes["app:chat"]).toEqual({ until: "2026-11-19T10:00:00.000Z" });
        const answer = await setAppMuteAction({ appId: "chat", duration: null });
        expect(answer.holds?.mutes).toEqual({});
    });

    it("refuses an end time sent by the browser", async () => {
        const answer = await setAppMuteAction({
            appId: "mail",
            duration: "1h",
            until: "2999-01-01T00:00:00.000Z"
        });
        expect(answer.error).toBe("switcher.muteFailed");
        expect(state.writes).toBe(0);
    });

    it.each([
        [{ appId: "mail", duration: "forever" }],
        [{ appId: "mail" }],
        [{ appId: "Mail!", duration: "1h" }],
        [{ appId: "vault", duration: "1h" }],
        [{ appId: "no-such-app", duration: "1h" }],
        ["mail"],
        [null]
    ])("refuses %j and saves nothing", async (input) => {
        const answer = await setAppMuteAction(input);
        expect(answer.error).toBe("switcher.muteFailed");
        expect(state.writes).toBe(0);
    });
});

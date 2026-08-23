/**
 * Which clock the server reads an account's hours on.
 *
 * "Automatic" is what almost every account keeps and it means the device's - an
 * answer a browser has and a server does not. So the dashboard reports it once
 * and everything resolved without a browser uses that: a status schedule
 * deciding whether somebody is hidden right now, a date rendered into a page.
 *
 * The case pinned hardest here is the first write, because the obvious way to
 * make it idempotent silently skips exactly the account it exists for: the
 * column is null until a browser has ever said, and "where the column is not
 * already Madrid" does not match a null in SQL. That version wrote nothing,
 * forever, and the only symptom was a schedule that never ran.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let stored: { displayPrefs: string | null; deviceTimeZone: string | null } = {
    displayPrefs: null,
    deviceTimeZone: null
};

const update = vi.fn(async ({ data }: { data: { deviceTimeZone: string } }) => {
    stored = { ...stored, deviceTimeZone: data.deviceTimeZone };
    return stored;
});

vi.mock("@polaris/db", () => ({
    prisma: { user: { findUnique: vi.fn(async () => ({ ...stored })), update } }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined)
}));
vi.mock("@/lib/session", () => ({ resolveSession: vi.fn(async () => null) }));

/** A fresh copy of the module, because its reads are memoized per request and a
 *  test that writes and then reads is two requests. */
async function service() {
    vi.resetModules();
    return import("@/lib/display-prefs-service");
}

beforeEach(() => {
    stored = { displayPrefs: null, deviceTimeZone: null };
    update.mockClear();
});

describe("writing down the zone a browser reports", () => {
    it("records it for an account that has never had one", async () => {
        const { recordDeviceTimeZone } = await service();
        expect(await recordDeviceTimeZone("u1", "Europe/Madrid")).toBe(true);
        expect(update).toHaveBeenCalledTimes(1);
        expect(stored.deviceTimeZone).toBe("Europe/Madrid");
    });

    it("writes nothing when it already says that", async () => {
        stored = { ...stored, deviceTimeZone: "Europe/Madrid" };
        const { recordDeviceTimeZone } = await service();
        expect(await recordDeviceTimeZone("u1", "Europe/Madrid")).toBe(false);
        expect(update).not.toHaveBeenCalled();
    });

    it("follows an account that has moved", async () => {
        stored = { ...stored, deviceTimeZone: "Europe/Madrid" };
        const { recordDeviceTimeZone } = await service();
        expect(await recordDeviceTimeZone("u1", "America/New_York")).toBe(true);
        expect(stored.deviceTimeZone).toBe("America/New_York");
    });

    it("refuses anything that is not a zone, and refuses automatic itself", async () => {
        // It arrives from a browser, and "auto" would be storing the question.
        const { recordDeviceTimeZone } = await service();
        expect(await recordDeviceTimeZone("u1", "auto")).toBe(false);
        expect(await recordDeviceTimeZone("u1", "Mars/Olympus_Mons")).toBe(false);
        expect(update).not.toHaveBeenCalled();
    });
});

describe("what automatic resolves to afterwards", () => {
    it("is the reported zone, which is what the hours are then read on", async () => {
        stored = { displayPrefs: null, deviceTimeZone: "Europe/Madrid" };
        const { resolveDisplayPreferencesFor } = await service();
        expect((await resolveDisplayPreferencesFor("u1")).timeZone).toBe("Europe/Madrid");
    });

    it("is still automatic before any browser has said", async () => {
        const { resolveDisplayPreferencesFor } = await service();
        expect((await resolveDisplayPreferencesFor("u1")).timeZone).toBe("auto");
    });

    it("leaves a zone the account chose alone", async () => {
        // Somebody who picked one in Preferences meant it, including while they
        // are reading this from somewhere else.
        stored = { displayPrefs: '{"timeZone":"UTC"}', deviceTimeZone: "Europe/Madrid" };
        const { resolveDisplayPreferencesFor } = await service();
        expect((await resolveDisplayPreferencesFor("u1")).timeZone).toBe("UTC");
    });
});

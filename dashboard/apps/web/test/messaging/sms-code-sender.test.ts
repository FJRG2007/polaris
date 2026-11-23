/**
 * SMS codes are an administrator's switch: off until a connected SMS sender an
 * administrator added is picked, never carried by a person's own alert sender,
 * and a number can be confirmed by SMS when WhatsApp is not set up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();
const channels: { id: string; ownerId: string; platform: string; status: string }[] = [];
const admins = new Set<string>();

const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const row = channels.find((channel) =>
        Object.entries(where).every(([key, value]) => (channel as Record<string, unknown>)[key] === value)
    );
    return row ? { id: row.id, ownerId: row.ownerId } : null;
});

vi.mock("@polaris/db", () => ({
    prisma: {
        channel: {
            findFirst,
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
                const row = channels.find((channel) => channel.id === where.id);
                return row ? { id: row.id, platform: row.platform, status: row.status } : null;
            })
        },
        user: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ isAdmin: admins.has(where.id) }))
        }
    }
}));
vi.mock("@/lib/setting-store", () => ({
    getSettings: vi.fn(async (keys: readonly string[]) => {
        const out = new Map<string, string>();
        for (const key of keys) if (settings.has(key)) out.set(key, settings.get(key) as string);
        return out;
    }),
    setSetting: vi.fn(async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    })
}));

const { codeRouteFor, codeSenderReady, phoneCodeRoute, setCodeSender } = await import("@/lib/messaging/code-senders");
const { NO_CODE_SENDER, resolveCodeRoute } = await import("@/lib/messaging/code-route");

beforeEach(() => {
    settings.clear();
    channels.length = 0;
    admins.clear();
    findFirst.mockClear();
    admins.add("admin-1");
    channels.push(
        { id: "admin-sms", ownerId: "admin-1", platform: "sms", status: "connected" },
        { id: "personal-sms", ownerId: "user-1", platform: "sms", status: "connected" },
        { id: "down-sms", ownerId: "admin-1", platform: "sms", status: "error" }
    );
});

describe("SMS code sender", () => {
    it("is off by default and names the page that turns it on", async () => {
        expect(await codeSenderReady("sms")).toBe(false);
        expect(await codeRouteFor("sms", "user-1")).toEqual({ channelId: null, blocker: NO_CODE_SENDER.sms });
        expect(NO_CODE_SENDER.sms).toContain("Integrations > Messaging");
    });

    it("never falls back to the person's own SMS sender", async () => {
        const route = await codeRouteFor("sms", "user-1");
        expect(route.channelId).toBeNull();
        // The own-channel lookup is not even made for SMS.
        expect(findFirst).not.toHaveBeenCalled();
    });

    it("accepts only a connected sender an administrator added", async () => {
        expect(await setCodeSender("sms", "personal-sms")).toHaveProperty("error");
        expect(await setCodeSender("sms", "down-sms")).toHaveProperty("error");
        expect(await codeSenderReady("sms")).toBe(false);

        expect(await setCodeSender("sms", "admin-sms")).toEqual({});
        expect(await codeSenderReady("sms")).toBe(true);
        expect(await codeRouteFor("sms", "user-1")).toEqual({ channelId: "admin-sms", via: "admin" });

        expect(await setCodeSender("sms", null)).toEqual({});
        expect(await codeSenderReady("sms")).toBe(false);
    });

    it("stops routing as soon as the picked sender stops being connected", async () => {
        await setCodeSender("sms", "admin-sms");
        const sender = channels.find((channel) => channel.id === "admin-sms");
        if (sender) sender.status = "error";
        expect(await codeSenderReady("sms")).toBe(false);
    });

    it("confirms a number by SMS when WhatsApp cannot, WhatsApp first otherwise", async () => {
        expect(await phoneCodeRoute("user-1")).toBeNull();
        await setCodeSender("sms", "admin-sms");
        expect(await phoneCodeRoute("user-1")).toEqual({ platform: "sms", channelId: "admin-sms" });
        channels.push({ id: "admin-wa", ownerId: "admin-1", platform: "whatsapp", status: "connected" });
        await setCodeSender("whatsapp", "admin-wa");
        expect(await phoneCodeRoute("user-1")).toEqual({ platform: "whatsapp", channelId: "admin-wa" });
    });

    it("resolves an SMS route with no own channel to the blocker", () => {
        expect(resolveCodeRoute("sms", { adminSender: null, ownChannel: null })).toEqual({
            channelId: null,
            blocker: NO_CODE_SENDER.sms
        });
    });
});

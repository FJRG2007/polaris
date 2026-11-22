import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bot profile actions end to end below the session: admins only, the token
 * read on the server, Telegram's refusals worded in the real catalogue (a rate
 * limit as minutes or hours to wait), and every change audited.
 */

const recordAudit = vi.fn(async (_entry: unknown) => undefined);
let adminSignedIn = true;
let locale: "en-US" | "es-ES" = "en-US";
let token: string | null = "123:abc";
let answer: (method: string) => { status: number; json: unknown };

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({
    requireAdmin: async () => {
        if (!adminSignedIn) throw new Error("forbidden");
        return { id: "admin-1" };
    }
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/messaging/code-senders", () => ({ setCodeSender: async () => ({}) }));
vi.mock("@/lib/messaging/channel-admin", () => ({ telegramBotToken: async () => token }));
vi.mock("@/lib/i18n/request", async () => {
    const { translatorFor } = await import("../../src/lib/i18n/translate");
    return { getTranslations: async (namespace: "admin") => translatorFor(locale, namespace) };
});
vi.mock("@/lib/safe-fetch", () => ({
    configuredRequest: async (address: string) => {
        const { status, json } = answer(address.split("/").pop()!);
        return new Response(JSON.stringify(json), { status });
    }
}));


const actions = await import("../../src/app/(app)/admin/integrations/messaging/actions");

const CHANNEL = "6f1c1a52-6a3e-4c55-9d4a-0d1f1b2c3d4e";
const OK = (result: unknown = true) => ({ status: 200, json: { ok: true, result } });
const PROFILE = (method: string) => {
    if (method === "getMe") return OK({ id: 1, first_name: "Polaris", username: "polaris_bot" });
    if (method === "getMyName") return OK({ name: "Polaris" });
    if (method === "getMyDescription") return OK({ description: "" });
    if (method === "getMyShortDescription") return OK({ short_description: "" });
    return OK({ total_count: 1 });
};

beforeEach(() => {
    recordAudit.mockClear();
    adminSignedIn = true;
    locale = "en-US";
    token = "123:abc";
    answer = PROFILE;
});

describe("applyTelegramBotProfileAction", () => {
    it("words a rate limit as the time to wait and still reports the fields that went through", async () => {
        answer = (method) =>
            method === "setMyName"
                ? { status: 429, json: { ok: false, error_code: 429, parameters: { retry_after: 1500 } } }
                : PROFILE(method);
        const result = await actions.applyTelegramBotProfileAction({ channelId: CHANNEL, mode: "polaris" });
        expect(result.results?.find((entry) => entry.field === "name")).toEqual({
            field: "name",
            ok: false,
            error: "Telegram asks to wait 25 minutes before changing this again."
        });
        expect(result.results?.filter((entry) => entry.ok).map((entry) => entry.field).sort()).toEqual([
            "description",
            "photo",
            "shortDescription"
        ]);
        expect(result.profile?.username).toBe("polaris_bot");
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                actorId: "admin-1",
                action: "messaging.bot-profile.updated",
                targetId: CHANNEL,
                metadata: expect.objectContaining({ mode: "polaris", failed: ["name"] })
            })
        );
    });

    it("words a long wait in hours, in Spanish too", async () => {
        locale = "es-ES";
        answer = () => ({ status: 429, json: { ok: false, error_code: 429, parameters: { retry_after: 7200 } } });
        const result = await actions.applyTelegramBotProfileAction({ channelId: CHANNEL, mode: "custom", name: "Acme" });
        expect(result.results).toEqual([
            { field: "name", ok: false, error: "Telegram pide esperar 2 horas antes de volver a cambiarlo." }
        ]);
    });

    it("refuses a custom save with nothing in it, and a name longer than Telegram allows", async () => {
        expect((await actions.applyTelegramBotProfileAction({ channelId: CHANNEL, mode: "custom" })).error).toBeTruthy();
        const long = await actions.applyTelegramBotProfileAction({ channelId: CHANNEL, mode: "custom", name: "x".repeat(65) });
        expect(long.error).toBeTruthy();
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("needs an administrator", async () => {
        adminSignedIn = false;
        await expect(actions.applyTelegramBotProfileAction({ channelId: CHANNEL, mode: "polaris" })).rejects.toThrow();
    });

    it("says so when the channel holds no bot token", async () => {
        token = null;
        const result = await actions.applyTelegramBotProfileAction({ channelId: CHANNEL, mode: "polaris" });
        expect(result.error).toBe("This channel has no bot token saved.");
    });
});

describe("telegramBotProfileAction", () => {
    it("tells the admin a refused token needs replacing", async () => {
        answer = () => ({ status: 401, json: { ok: false, error_code: 401, description: "Unauthorized" } });
        const result = await actions.telegramBotProfileAction(CHANNEL);
        expect(result).toEqual({ error: "Telegram refused the bot token. Paste a new one and save." });
    });

    it("never hands the token back", async () => {
        const result = await actions.telegramBotProfileAction(CHANNEL);
        expect(JSON.stringify(result)).not.toContain("123:abc");
        expect(result.profile).toMatchObject({ name: "Polaris", hasPhoto: true });
    });
});

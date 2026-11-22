import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bot profile calls, with the Bot API answered by a fake behind the guarded
 * fetch: what Polaris asks Telegram for, and how each refusal comes back - a
 * rate limit with its wait, a refused token, and a picture Telegram will not take.
 */

interface Asked {
    method: string;
    contentType: string | undefined;
    body: Uint8Array | string | undefined;
}

const asked: Asked[] = [];
let answer: (method: string, body: unknown) => { status: number; json: unknown };

vi.mock("@/lib/safe-fetch", () => ({
    configuredRequest: async (address: string, init: RequestInit) => {
        const method = address.split("/").pop()!;
        const contentType = (init.headers as Record<string, string> | undefined)?.["content-type"];
        const body = init.body as Uint8Array | string | undefined;
        asked.push({ method, contentType, body });
        const parsed = typeof body === "string" ? JSON.parse(body) : body;
        const { status, json } = answer(method, parsed);
        return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    }
}));

const profile = await import("../../src/lib/messaging/telegram-bot-profile");

const OK = (result: unknown = true) => ({ status: 200, json: { ok: true, result } });

function jsonBodies(method: string): Record<string, unknown>[] {
    return asked.filter((call) => call.method === method).map((call) => JSON.parse(call.body as string));
}

beforeEach(() => {
    asked.length = 0;
    answer = () => OK();
});

describe("readBotProfile", () => {
    it("reads the bot's name, descriptions and picture state", async () => {
        answer = (method) => {
            if (method === "getMe") return OK({ id: 42, first_name: "Dymo", username: "dymo_bot" });
            if (method === "getMyName") return OK({ name: "Dymo" });
            if (method === "getMyDescription") return OK({ description: "Old description" });
            if (method === "getMyShortDescription") return OK({ short_description: "Old short" });
            if (method === "getUserProfilePhotos") return OK({ total_count: 0, photos: [] });
            return OK();
        };
        await expect(profile.readBotProfile("123:abc")).resolves.toEqual({
            username: "dymo_bot",
            name: "Dymo",
            description: "Old description",
            shortDescription: "Old short",
            hasPhoto: false
        });
        expect(jsonBodies("getUserProfilePhotos")[0]).toEqual({ user_id: 42, limit: 1 });
    });

    it("reports a refused token as such", async () => {
        answer = () => ({ status: 401, json: { ok: false, error_code: 401, description: "Unauthorized" } });
        const failure = await profile.readBotProfile("bad").catch((caught: unknown) => caught);
        expect(failure).toBeInstanceOf(profile.TelegramCallError);
        expect((failure as InstanceType<typeof profile.TelegramCallError>).failure).toEqual({ kind: "tokenRefused" });
    });
});

describe("applyPolarisBranding", () => {
    it("sets the name, both descriptions in English and Spanish, and a 640 px JPG picture", async () => {
        const results = await profile.applyPolarisBranding("123:abc");
        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.map((result) => result.field).sort()).toEqual(["description", "name", "photo", "shortDescription"]);

        expect(jsonBodies("setMyName")).toEqual([
            { name: "Polaris", language_code: "" },
            { name: "Polaris", language_code: "es" }
        ]);
        expect(jsonBodies("setMyDescription").map((body) => body.language_code)).toEqual(["", "es"]);
        expect(jsonBodies("setMyShortDescription")[1]!.short_description).toBe(
            profile.POLARIS_BRANDING.es.shortDescription
        );

        const photo = asked.find((call) => call.method === "setMyProfilePhoto")!;
        expect(photo.contentType).toMatch(/^multipart\/form-data; boundary=polaris[0-9a-f]+$/);
        const bytes = Buffer.from(photo.body as Uint8Array);
        const text = bytes.toString("latin1");
        expect(text).toContain('{"type":"static","photo":"attach://picture"}');
        const start = bytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
        const boundary = photo.contentType!.split("boundary=")[1]!;
        const end = bytes.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
        const meta = await sharp(bytes.subarray(start, end)).metadata();
        expect(meta).toMatchObject({ format: "jpeg", width: 640, height: 640 });
    });

    it("keeps going after a rate limit on the name, and says how long to wait", async () => {
        answer = (method) =>
            method === "setMyName"
                ? {
                      status: 429,
                      json: {
                          ok: false,
                          error_code: 429,
                          description: "Too Many Requests: retry after 3541",
                          parameters: { retry_after: 3541 }
                      }
                  }
                : OK();
        const results = await profile.applyPolarisBranding("123:abc");
        const name = results.find((result) => result.field === "name")!;
        expect(name).toEqual({ field: "name", ok: false, failure: { kind: "rateLimited", retryAfter: 3541 } });
        // The Spanish name is not asked for once Telegram said to wait.
        expect(jsonBodies("setMyName")).toHaveLength(1);
        expect(results.filter((result) => result.field !== "name").every((result) => result.ok)).toBe(true);
    });

    it("reports a picture Telegram does not take without failing the rest", async () => {
        answer = (method) =>
            method === "setMyProfilePhoto"
                ? { status: 404, json: { ok: false, error_code: 400, description: "Bad Request: method not found" } }
                : OK();
        const results = await profile.applyPolarisBranding("123:abc");
        expect(results.find((result) => result.field === "photo")).toEqual({
            field: "photo",
            ok: false,
            failure: { kind: "refused", description: "method not found" }
        });
        expect(results.filter((result) => result.ok)).toHaveLength(3);
    });
});

describe("applyCustomProfile", () => {
    it("writes only the given fields as the default and clears the Spanish one", async () => {
        const results = await profile.applyCustomProfile("123:abc", { name: "Acme alerts" });
        expect(results).toEqual([{ field: "name", ok: true }]);
        expect(jsonBodies("setMyName")).toEqual([
            { name: "Acme alerts", language_code: "" },
            { name: "", language_code: "es" }
        ]);
        expect(asked.map((call) => call.method)).toEqual(["setMyName", "setMyName"]);
    });
});

describe("failureOf", () => {
    it("treats an answer that is not the Bot API's as unreachable", () => {
        expect(profile.failureOf(502, null)).toEqual({ kind: "unreachable" });
    });

    it("waits at least a second when Telegram gives no retry_after", () => {
        expect(profile.failureOf(429, { ok: false, error_code: 429 })).toEqual({ kind: "rateLimited", retryAfter: 60 });
    });
});

/**
 * `/api/translate`: signed in, rate limited, the body checked before anything
 * is sent, and the engine that answered named in the reply.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    user: { id: "user-1", isAdmin: false } as { id: string; isAdmin: boolean } | Response,
    rate: { ok: true },
    settings: null as string | null,
    status: { deepl: true, google: false, polar: true },
    serverTranslate: vi.fn(
        async (_engine: string, _user: string, texts: readonly string[]) => ({
            texts: texts.map((text) => `<${text}>`),
            detected: "ES"
        })
    ),
    serverDetect: vi.fn(async () => "pt-br")
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        apiSession: { apiUser: async () => mocks.user },
        rateLimitService: { rateLimit: async () => mocks.rate },
        settingStore: { getSetting: async () => mocks.settings },
        i18nRequest: { getLocale: async () => "en-US" },
        translateEngines: {
            serverEngineStatus: async () => mocks.status,
            serverTranslate: mocks.serverTranslate,
            serverDetect: mocks.serverDetect
        }
    }
}));

import { GET, POST } from "@polaris-app/translate/src/routes/api/translate/route";
import { POST as DETECT } from "@polaris-app/translate/src/routes/api/translate/detect/route";

function post(body: unknown): Request {
    return new Request("http://localhost/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: "user-1", isAdmin: false };
    mocks.rate = { ok: true };
    mocks.settings = null;
    mocks.status = { deepl: true, google: false, polar: true };
});

describe("POST /api/translate", () => {
    it("translates with the first usable engine and names it", async () => {
        const response = await POST(post({ texts: ["hola"], to: "en" }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ texts: ["<hola>"], engine: "deepl", detected: "es" });
        expect(mocks.serverTranslate).toHaveBeenCalledWith("deepl", "user-1", ["hola"], null, "en");
    });

    it("refuses anybody not signed in", async () => {
        mocks.user = new Response(null, { status: 401 });
        expect((await POST(post({ texts: ["hola"], to: "en" }))).status).toBe(401);
        expect(mocks.serverTranslate).not.toHaveBeenCalled();
    });

    it("holds a caller past the rate", async () => {
        mocks.rate = { ok: false };
        expect((await POST(post({ texts: ["hola"], to: "en" }))).status).toBe(429);
        expect(mocks.serverTranslate).not.toHaveBeenCalled();
    });

    it.each([
        ["not JSON", "{"],
        ["an unknown language", { texts: ["hola"], to: "klingon" }],
        ["no text", { texts: [""], to: "en" }],
        ["a text past the limit", { texts: ["a".repeat(5001)], to: "en" }]
    ])("refuses %s before sending anything", async (_name, body) => {
        const response = await POST(post(body));
        expect(response.status).toBe(400);
        expect(mocks.serverTranslate).not.toHaveBeenCalled();
    });

    it("refuses a body declared past the limit without reading it", async () => {
        const request = new Request("http://localhost/api/translate", {
            method: "POST",
            headers: { "content-length": String(1024 * 1024) },
            body: "{}"
        });
        expect((await POST(request)).status).toBe(413);
    });

    it("never swaps a named engine for another", async () => {
        const response = await POST(post({ texts: ["hola"], to: "en", engine: "google" }));
        expect(response.status).toBe(409);
        expect(mocks.serverTranslate).not.toHaveBeenCalled();
    });

    it("says no engine can answer when the owner switched them all off", async () => {
        mocks.settings = JSON.stringify({ engines: { deepl: false, polar: false } });
        const response = await POST(post({ texts: ["hola"], to: "en" }));
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe("noEngine");
    });

    it("says a provider is paused in words, not internals", async () => {
        mocks.serverTranslate.mockRejectedValueOnce(
            Object.assign(new Error("translation engine paused"), {
                name: "EngineRefusal",
                code: "paused"
            })
        );
        const response = await POST(post({ texts: ["hola"], to: "en" }));
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body.error).toBe("paused");
        expect(body.message).not.toMatch(/EngineRefusal|deepl/i);
    });
});

describe("GET /api/translate", () => {
    it("lists the usable server engines and the default target", async () => {
        const response = await GET();
        expect(await response.json()).toEqual({
            engines: ["deepl", "polar"],
            browser: true,
            defaultTarget: "en"
        });
    });
});

describe("POST /api/translate/detect", () => {
    it("answers the language as one of Translate's codes", async () => {
        const response = await DETECT(post({ text: "olá" }));
        expect(await response.json()).toEqual({ language: "pt-BR", engine: "deepl" });
    });

    it("prefers Google, which has a detection call of its own", async () => {
        mocks.status = { deepl: true, google: true, polar: true };
        await DETECT(post({ text: "olá" }));
        expect(mocks.serverDetect).toHaveBeenCalledWith("google", "user-1", "olá");
    });
});

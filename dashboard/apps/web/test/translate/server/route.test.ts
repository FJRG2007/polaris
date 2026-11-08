/**
 * `/api/translate`: signed in, rate limited, the body checked before anything
 * is sent, and the engine that answered named in the reply.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    user: { id: "user-1", isAdmin: false } as { id: string; isAdmin: boolean } | Response,
    rate: { ok: true },
    allowed: true,
    settings: null as string | null,
    status: { deepl: true, google: false, polar: true },
    serverTranslate: vi.fn(async (_engine: string, _user: string, texts: readonly string[]) => ({
        texts: texts.map((text) => `<${text}>`),
        detected: "ES"
    })),
    serverDetect: vi.fn(async () => "pt-br"),
    // Nothing set up to read pictures or recordings unless a test says so.
    serverMediaStatus: vi.fn(async () => ({ images: false, audio: false })),
    serverReadImage: vi.fn(async () => ({
        lines: [{ text: "SALIDA", box: [0.1, 0.2, 0.3, 0.05] }]
    })),
    serverTranscribe: vi.fn(async () => ({ text: "hola" }))
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        apiSession: { apiUser: async () => mocks.user },
        session: { sessionCan: async () => mocks.allowed },
        rateLimitService: { rateLimit: async () => mocks.rate },
        settingStore: { getSetting: async () => mocks.settings },
        i18nRequest: { getLocale: async () => "en-US" },
        translateEngines: {
            serverEngineStatus: async () => mocks.status,
            serverTranslate: mocks.serverTranslate,
            serverDetect: mocks.serverDetect,
            serverMediaStatus: mocks.serverMediaStatus,
            serverReadImage: mocks.serverReadImage,
            serverTranscribe: mocks.serverTranscribe
        }
    }
}));

import { GET, POST } from "@polaris-app/translate/src/routes/api/translate/route";
import { POST as DETECT } from "@polaris-app/translate/src/routes/api/translate/detect/route";
import { POST as IMAGE } from "@polaris-app/translate/src/routes/api/translate/image/route";
import { POST as TRANSCRIBE } from "@polaris-app/translate/src/routes/api/translate/transcribe/route";

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
    mocks.allowed = true;
    mocks.settings = null;
    mocks.status = { deepl: true, google: false, polar: true };
});

describe("POST /api/translate", () => {
    it("translates with the first usable engine and names it", async () => {
        const response = await POST(post({ texts: ["hola"], to: "en" }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            texts: ["<hola>"],
            engine: "deepl",
            detected: "es"
        });
        expect(mocks.serverTranslate).toHaveBeenCalledWith("deepl", "user-1", ["hola"], null, "en");
    });

    it("refuses anybody not signed in", async () => {
        mocks.user = new Response(null, { status: 401 });
        expect((await POST(post({ texts: ["hola"], to: "en" }))).status).toBe(401);
        expect(mocks.serverTranslate).not.toHaveBeenCalled();
    });

    it("refuses a role without Translate", async () => {
        mocks.allowed = false;
        expect((await POST(post({ texts: ["hola"], to: "en" }))).status).toBe(403);
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
        // One request's technical cap; the screen cuts longer texts before sending.
        ["a text past one request's cap", { texts: ["a".repeat(50_001)], to: "en" }]
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

    it("tells only an administrator what to set up", async () => {
        mocks.settings = JSON.stringify({ engines: { deepl: false, polar: false } });
        const reader = await (await POST(post({ texts: ["hola"], to: "en" }))).json();
        expect(reader.message).not.toMatch(/key|DeepL|Google/);
        mocks.user = { id: "user-1", isAdmin: true };
        const admin = await (await POST(post({ texts: ["hola"], to: "en" }))).json();
        expect(admin.message).toMatch(/DeepL/);
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
            local: true,
            defaultTarget: "en",
            order: ["browser", "local", "libretranslate", "deepl", "google", "polar"],
            charLimit: null,
            reads: { images: false, audio: false }
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

describe("no length limit unless one is set", () => {
    it("translates a long text in pieces the engine takes, and answers it whole", async () => {
        mocks.status = { deepl: false, google: false, polar: true };
        const text = Array.from({ length: 6 }, () => "Una frase. ".repeat(500).trim()).join("\n\n");
        const response = await POST(post({ texts: [text], from: "es", to: "en" }));
        expect(response.status).toBe(200);
        const answer = (await response.json()) as { texts: string[] };
        expect(mocks.serverTranslate.mock.calls.length).toBeGreaterThan(1);
        for (const call of mocks.serverTranslate.mock.calls) {
            expect((call[2] as string[]).join("").length).toBeLessThanOrEqual(6000);
        }
        expect(answer.texts[0]!.split("\n\n")).toHaveLength(6);
    });

    it("refuses a text past the administrator's limit, naming it", async () => {
        mocks.settings = JSON.stringify({ charLimit: 100 });
        const response = await POST(post({ texts: ["a".repeat(101)], to: "en" }));
        expect(response.status).toBe(413);
        const answer = (await response.json()) as { error: string; message: string };
        expect(answer.error).toBe("overLimit");
        expect(answer.message).toContain("100");
        expect(mocks.serverTranslate).not.toHaveBeenCalled();
    });

    it("reads a stored limit leniently and says it, with what can be read", async () => {
        mocks.settings = JSON.stringify({ charLimit: "lots" });
        mocks.serverMediaStatus.mockResolvedValueOnce({ images: true, audio: false });
        const answer = (await (await GET()).json()) as Record<string, unknown>;
        expect(answer.charLimit).toBeNull();
        expect(answer.reads).toEqual({ images: true, audio: false });
    });
});

function file(path: string, body: Uint8Array, type = "application/octet-stream"): Request {
    return new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": type },
        body
    });
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe("POST /api/translate/image", () => {
    it("answers the lines in a picture, whatever type it was sent as", async () => {
        const response = await IMAGE(file("/api/translate/image", PNG, "text/plain"));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            lines: [{ text: "SALIDA", box: [0.1, 0.2, 0.3, 0.05] }]
        });
        expect(mocks.serverReadImage).toHaveBeenCalledWith(
            "user-1",
            expect.any(Uint8Array),
            "image/png"
        );
    });

    it("refuses what is not a picture, and a body past the cap", async () => {
        expect((await IMAGE(file("/api/translate/image", new Uint8Array([1, 2, 3])))).status).toBe(
            415
        );
        const big = new Uint8Array(8 * 1024 * 1024 + 1);
        big.set(PNG);
        expect((await IMAGE(file("/api/translate/image", big))).status).toBe(413);
        expect(mocks.serverReadImage).not.toHaveBeenCalled();
    });

    it("refuses a caller without the permission before reading anything", async () => {
        mocks.allowed = false;
        expect((await IMAGE(file("/api/translate/image", PNG))).status).toBe(403);
    });
});

describe("POST /api/translate/transcribe", () => {
    const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0]);

    it("answers what was said", async () => {
        const response = await TRANSCRIBE(file("/api/translate/transcribe?durationMs=2000", OGG));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ text: "hola" });
    });

    it("refuses a recording too long, or one that is not audio", async () => {
        expect(
            (await TRANSCRIBE(file("/api/translate/transcribe?durationMs=999999999", OGG))).status
        ).toBe(400);
        expect(
            (await TRANSCRIBE(file("/api/translate/transcribe?durationMs=10", PNG))).status
        ).toBe(415);
        expect(mocks.serverTranscribe).not.toHaveBeenCalled();
    });

    it("says the engine cannot answer when no model transcribes here", async () => {
        mocks.serverTranscribe.mockRejectedValueOnce(
            Object.assign(new Error("x"), { name: "EngineRefusal", code: "unavailable" })
        );
        const response = await TRANSCRIBE(file("/api/translate/transcribe?durationMs=10", OGG));
        expect(response.status).toBe(409);
    });
});

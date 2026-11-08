import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("@polaris/app-host", () => ({
    host: {
        settingStore: {
            getSetting: async (key: string) => store.get(key) ?? null,
            setSetting: async (key: string, value: string) => void store.set(key, value)
        },
        translateEngines: {
            sealEngineKey: async (secret: string) => `sealed:${secret}`,
            openEngineKey: async (sealed: string) => sealed.replace(/^sealed:/, "")
        },
        safeFetch: { configuredRequest: vi.fn() }
    }
}));

import {
    libreCode,
    libreDetect,
    libreTranslate,
    libreTranslateInput,
    libreTranslateReady,
    loadLibreTranslate,
    saveLibreTranslate,
    type ConfiguredRequest
} from "@polaris-app/translate/src/lib/libretranslate";
import { failureOf } from "@polaris-app/translate/src/lib/serve";
import { DEFAULT_ORDER, readOrder, readSettings } from "@polaris-app/translate/src/model/schemas";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const LANGUAGES = [{ code: "en", name: "English", targets: ["es"] }];

/** A LibreTranslate that lists its languages and detects with any key. */
const answering = (path: string) =>
    path === "/detect" ? json([{ language: "en", confidence: 90 }]) : json(LANGUAGES);

function server(answer: (path: string, body: Record<string, unknown> | null) => Response) {
    return vi.fn<ConfiguredRequest>(async (address, init, options) => {
        expect(options).toEqual({ allowPrivate: true });
        const path = new URL(address).pathname;
        return answer(
            path,
            init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
        );
    });
}

async function configure(key?: string) {
    const ok = server(answering);
    await saveLibreTranslate(
        libreTranslateInput.parse({ url: "http://192.168.1.20:5000/", key }),
        ok
    );
}

beforeEach(() => store.clear());

describe("LibreTranslate settings", () => {
    it("is off until an address is set", async () => {
        expect(await libreTranslateReady()).toBe(false);
        await expect(
            libreTranslate(
                ["hello"],
                null,
                "es",
                server(() => json({}))
            )
        ).rejects.toMatchObject({
            name: "EngineRefusal",
            code: "unavailable"
        });
    });

    it("keeps an address only once the server answered /languages, the key sealed", async () => {
        const request = server(answering);
        const saved = await saveLibreTranslate(
            libreTranslateInput.parse({ url: " http://192.168.1.20:5000/ ", key: "abc" }),
            request
        );
        expect(saved).toEqual({ url: "http://192.168.1.20:5000", hasKey: true });
        expect(request.mock.calls[0]![0]).toBe("http://192.168.1.20:5000/languages");
        expect(store.get("translate.libretranslate")).toContain("sealed:abc");
        expect(store.get("translate.libretranslate")).not.toMatch(/"abc"/);
        expect(await loadLibreTranslate()).toEqual({
            url: "http://192.168.1.20:5000",
            hasKey: true
        });
        expect(await libreTranslateReady()).toBe(true);
    });

    it("refuses an address that does not answer as LibreTranslate, and keeps nothing", async () => {
        const html = server(() => new Response("<html>", { status: 200 }));
        await expect(
            saveLibreTranslate(libreTranslateInput.parse({ url: "https://example.test" }), html)
        ).rejects.toMatchObject({ name: "EngineRefusal" });
        expect(store.size).toBe(0);
    });

    it("refuses what is not an http address and switches off on an empty one", async () => {
        expect(libreTranslateInput.safeParse({ url: "ftp://x.test" }).success).toBe(false);
        expect(libreTranslateInput.safeParse({ url: "https://u:p@x.test" }).success).toBe(false);
        await configure("abc");
        expect(await saveLibreTranslate(libreTranslateInput.parse({ url: "" }))).toEqual({
            url: null,
            hasKey: false
        });
        expect(await libreTranslateReady()).toBe(false);
    });
});

describe("LibreTranslate key handling", () => {
    it("checks a new key against the server before keeping it", async () => {
        const refusing = server((path) =>
            path === "/detect" ? json({ error: "Invalid API key" }, 403) : json(LANGUAGES)
        );
        await expect(
            saveLibreTranslate(
                libreTranslateInput.parse({ url: "http://192.168.1.20:5000", key: "wrong" }),
                refusing
            )
        ).rejects.toMatchObject({ name: "EngineRefusal" });
        expect(store.size).toBe(0);
    });

    it("never sends a kept key to a different server", async () => {
        await configure("abc");
        const other = server(answering);
        const saved = await saveLibreTranslate(
            libreTranslateInput.parse({ url: "https://elsewhere.test" }),
            other
        );
        expect(saved).toEqual({ url: "https://elsewhere.test", hasKey: false });
        expect(JSON.stringify(other.mock.calls)).not.toContain("abc");
        expect(store.get("translate.libretranslate")).not.toContain("abc");
    });

    it("keeps the key when the same server is saved again", async () => {
        await configure("abc");
        const same = server(answering);
        const saved = await saveLibreTranslate(
            libreTranslateInput.parse({ url: "http://192.168.1.20:5000/" }),
            same
        );
        expect(saved).toEqual({ url: "http://192.168.1.20:5000", hasKey: true });
    });

    it("refuses an answer past the size cap even when it declares no length", async () => {
        await configure();
        const huge = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
            }
        });
        await expect(
            libreTranslate(["hello"], "en", "es", server(() => new Response(huge)))
        ).rejects.toMatchObject({ name: "EngineRefusal", code: "failed" });
    });
});

describe("LibreTranslate engine", () => {
    it("translates a batch with the key, reading the detected language", async () => {
        await configure("abc");
        const request = server((path, body) => {
            expect(path).toBe("/translate");
            expect(body).toEqual({
                q: ["hello", "bye"],
                source: "auto",
                target: "pt",
                format: "text",
                api_key: "abc"
            });
            return json({
                translatedText: ["olá", "tchau"],
                detectedLanguage: [
                    { confidence: 90, language: "en" },
                    { confidence: 90, language: "en" }
                ]
            });
        });
        expect(await libreTranslate(["hello", "bye"], null, "pt-BR", request)).toEqual({
            texts: ["olá", "tchau"],
            detected: "en"
        });
    });

    it("refuses an answer of another shape or count", async () => {
        await configure();
        await expect(
            libreTranslate(
                ["a", "b"],
                "en",
                "es",
                server(() => json({ translatedText: ["x"] }))
            )
        ).rejects.toMatchObject({ code: "failed" });
        await expect(
            libreTranslate(
                ["a"],
                "en",
                "es",
                server(() => json({ text: "x" }))
            )
        ).rejects.toMatchObject({ code: "failed" });
    });

    it("classifies failures like the other engines", async () => {
        await configure();
        const slow = server(() => json({ error: "Slowdown" }, 429));
        const caught = await libreTranslate(["a"], "en", "es", slow).catch(
            (error: unknown) => error
        );
        expect(failureOf(caught)).toBe("paused");
        const bad = server(() => json({ error: "Invalid API key" }, 403));
        expect(
            failureOf(await libreTranslate(["a"], "en", "es", bad).catch((e: unknown) => e))
        ).toBe("failed");
        const down = vi.fn<ConfiguredRequest>(async () => {
            throw new Error("ECONNREFUSED");
        });
        expect(
            failureOf(await libreTranslate(["a"], "en", "es", down).catch((e: unknown) => e))
        ).toBe("failed");
    });

    it("detects with /detect, the most confident first", async () => {
        await configure();
        const request = server((path) => {
            expect(path).toBe("/detect");
            return json([
                { language: "it", confidence: 20 },
                { language: "es", confidence: 92 }
            ]);
        });
        expect(await libreDetect("hola a todos", request)).toBe("es");
    });

    it("spells languages the way LibreTranslate does", () => {
        expect(libreCode("zh-Hans")).toBe("zh");
        expect(libreCode("zh-Hant")).toBe("zt");
        expect(libreCode("en")).toBe("en");
    });
});

describe("LibreTranslate in the order", () => {
    it("is tried after the device engines by default", () => {
        expect(DEFAULT_ORDER).toEqual([
            "browser",
            "local",
            "libretranslate",
            "deepl",
            "google",
            "polar"
        ]);
    });

    it("joins an order stored before it existed right after the local engine", () => {
        expect(readOrder(["browser", "local", "deepl", "google", "polar"])).toEqual(DEFAULT_ORDER);
        expect(readOrder(["polar", "deepl", "local", "browser", "google"])).toEqual([
            "polar",
            "deepl",
            "local",
            "libretranslate",
            "browser",
            "google"
        ]);
    });

    it("is switched on in settings stored before it existed", () => {
        expect(readSettings({ engines: { deepl: false } }).engines.libretranslate).toBe(true);
    });
});

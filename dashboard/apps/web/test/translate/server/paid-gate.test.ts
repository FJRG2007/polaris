/**
 * DeepL and Google Cloud Translation are billed per character, so every request
 * goes through the paid-request gate: an account out of credit is asked once,
 * not on every keystroke, and the requests carry the documented shapes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let settings = new Map<string, string>();

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    },
    swapSetting: async (key: string, expected: string | null, value: string) => {
        if ((settings.get(key) ?? null) !== expected) return false;
        settings.set(key, value);
        return true;
    }
}));
vi.mock("@/lib/connections/attention", () => ({
    recordConnectionFailure: async () => true,
    clearConnectionFailure: async () => true
}));

import { deeplEndpoint, deeplTranslate } from "@/lib/integrations/deepl";
import { googleDetect, googleTranslate } from "@/lib/integrations/google-translate";
import { deeplSource, deeplTarget, googleCode } from "@/lib/translate/provider-codes";

let fetchMock: ReturnType<typeof vi.fn>;

function answer(status: number, body: unknown = {}) {
    fetchMock = vi.fn(async () => Response.json(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
    settings = new Map();
});

describe.each([
    ["deepl", (n: number) => deeplTranslate("key", [`a${n}`], "EN-US")],
    ["google-translate", (n: number) => googleTranslate("key", [`a${n}`], "en")],
    ["google-translate", () => googleDetect("key", "hola")]
] as const)("%s", (provider, request) => {
    it("sends one request while the account is out of credits", async () => {
        answer(402);
        for (let pass = 0; pass < 30; pass += 1) await request(pass).catch(() => undefined);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(settings.get(`integration.pause.${provider}`)).toContain("credits");
    });

    it("counts every request against the day", async () => {
        answer(500);
        await request(0).catch(() => undefined);
        const spent = JSON.parse(settings.get(`integration.spent.${provider}`) ?? "{}");
        expect(spent.count).toBe(1);
    });
});

describe("the day's characters", () => {
    it("are counted per request and stop the provider once spent", async () => {
        answer(200, { translations: [{ text: "x" }, { text: "y" }] });
        const day = new Date().toISOString().slice(0, 10);
        await deeplTranslate("key", ["abcd", "ef"], "EN-US");
        expect(JSON.parse(settings.get("integration.spent.deepl") ?? "{}")).toMatchObject({
            count: 1,
            chars: 6
        });
        settings.set(
            "integration.spent.deepl",
            JSON.stringify({ day, count: 1, chars: 1_000_000 })
        );
        await expect(deeplTranslate("key", ["a"], "EN-US")).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(settings.get("integration.pause.deepl")).toContain("budget");
    });
});

describe("DeepL", () => {
    it("treats its quota-exceeded answer as out of credits", async () => {
        answer(456);
        await deeplTranslate("key", ["a"], "EN-US").catch(() => undefined);
        expect(settings.get("integration.pause.deepl")).toContain("credits");
    });

    it("sends Free keys to the Free endpoint, with the key in the header", async () => {
        answer(200, { translations: [{ detected_source_language: "ES", text: "Hello" }] });
        const result = await deeplTranslate("abc:fx", ["Hola"], "EN-US");
        expect(result).toEqual({ texts: ["Hello"], detected: "es" });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://api-free.deepl.com/v2/translate");
        expect(new Headers(init.headers).get("authorization")).toBe("DeepL-Auth-Key abc:fx");
        expect(JSON.parse(String(init.body))).toEqual({ text: ["Hola"], target_lang: "EN-US" });
        expect(deeplEndpoint("pro-key")).toBe("https://api.deepl.com/v2/translate");
    });

    it("refuses an answer that does not match the texts sent", async () => {
        answer(200, { translations: [] });
        await expect(deeplTranslate("k", ["a"], "EN-US")).rejects.toThrow();
    });
});

describe("Google Cloud Translation", () => {
    it("keeps the key out of the address and asks for plain text", async () => {
        answer(200, {
            data: { translations: [{ translatedText: "Hello", detectedSourceLanguage: "es" }] }
        });
        const result = await googleTranslate("secret", ["Hola"], "en");
        expect(result).toEqual({ texts: ["Hello"], detected: "es" });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).not.toContain("secret");
        expect(new Headers(init.headers).get("x-goog-api-key")).toBe("secret");
        expect(JSON.parse(String(init.body))).toEqual({
            q: ["Hola"],
            target: "en",
            format: "text"
        });
    });

    it("reads a detection", async () => {
        answer(200, {
            data: { detections: [[{ language: "es", confidence: 1, isReliable: false }]] }
        });
        expect(await googleDetect("k", "hola")).toBe("es");
    });
});

describe("language spellings", () => {
    it("say each code the way the provider wants it", () => {
        expect(deeplTarget("en")).toBe("EN-US");
        expect(deeplTarget("pt-BR")).toBe("PT-BR");
        expect(deeplTarget("zh-Hans")).toBe("ZH-HANS");
        expect(deeplSource("pt-BR")).toBe("PT");
        expect(googleCode("zh-Hans")).toBe("zh-CN");
        expect(googleCode("zh-Hant")).toBe("zh-TW");
    });
});

import { describe, expect, it, vi } from "vitest";
import {
    localeLanguage,
    outgoingTarget,
    planBatches,
    sameLanguage,
    TranslationCache,
    translatesIncoming,
    unchanged
} from "@/lib/text-translation/logic";
import { TranslationQueue } from "@/lib/text-translation/queue";
import { readChatTranslation, readSentTranslation } from "@polaris/core";

const ON = { incoming: true, outgoing: null };
const message = { id: "m1", authorId: "other", kind: "text", body: "Hallo zusammen" };

describe("live translation decisions", () => {
    it("translates what others write, never your own words", () => {
        expect(translatesIncoming(message, "me", ON, "es")).toBe(true);
        expect(translatesIncoming({ ...message, authorId: "me" }, "me", ON, "es")).toBe(false);
    });
    it("stays off when the reader did not turn it on", () => {
        expect(translatesIncoming(message, "me", { incoming: false, outgoing: "de" }, "es")).toBe(false);
    });
    it("skips notices, tombstones, pending echoes and messages sent in the target", () => {
        expect(translatesIncoming({ ...message, kind: "system" }, "me", ON, "es")).toBe(false);
        expect(translatesIncoming({ ...message, deleted: true }, "me", ON, "es")).toBe(false);
        expect(translatesIncoming({ ...message, id: "pending:1" }, "me", ON, "es")).toBe(false);
        expect(translatesIncoming({ ...message, translated: { to: "es" } }, "me", ON, "es")).toBe(false);
    });
    it("sends in the chosen language, except an edit", () => {
        expect(outgoingTarget({ incoming: false, outgoing: "de" }, false)).toBe("de");
        expect(outgoingTarget({ incoming: false, outgoing: "de" }, true)).toBeNull();
        expect(outgoingTarget(ON, false)).toBeNull();
    });
});

describe("languages", () => {
    it("reads a locale as a target", () => {
        expect(localeLanguage("es-ES")).toBe("es");
        expect(localeLanguage("pt-BR")).toBe("pt-BR");
        expect(localeLanguage("zh-TW")).toBe("zh-Hant");
        expect(localeLanguage("xx-YY")).toBe("en");
    });
    it("compares base languages, and Chinese by script", () => {
        expect(sameLanguage("en-US", "en")).toBe(true);
        expect(sameLanguage("zh-Hans", "zh-Hant")).toBe(false);
        expect(sameLanguage(null, "en")).toBe(false);
    });
    it("sees an engine's unchanged answer as the same words", () => {
        expect(unchanged("Hola, ¿qué tal?", "hola qué tal")).toBe(true);
        expect(unchanged("Hola", "Hello")).toBe(false);
    });
});

describe("batches", () => {
    it("cuts by count and by the administrator's limit, refusing a text over it", () => {
        const texts = Array.from({ length: 120 }, () => "abc");
        expect(planBatches(texts, null).batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
        const { batches, tooLong } = planBatches(["aaaa", "bbbb", "cccccccccc", "dd"], 8);
        expect(batches).toEqual([[0, 1], [3]]);
        expect(tooLong).toEqual([2]);
    });
});

describe("cache", () => {
    it("is bounded and ends", () => {
        let now = 0;
        const cache = new TranslationCache<string>(2, 1000, () => now);
        cache.set("es", "a", "A");
        cache.set("es", "b", "B");
        cache.get("es", "a");
        cache.set("es", "c", "C");
        expect(cache.get("es", "b")).toBeUndefined();
        expect(cache.get("es", "a")).toBe("A");
        now = 2000;
        expect(cache.get("es", "a")).toBeUndefined();
    });
});

describe("queue", () => {
    const offer = { appId: "translate", endpoint: "/api/translate", page: "/translate" };
    const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    it("batches texts asked together into one request and caches the answers", async () => {
        const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
            if (!init?.method) return json({ charLimit: null });
            const { texts } = JSON.parse(String(init.body)) as { texts: string[] };
            return json({ texts: texts.map((text) => (text === "hola" ? "hola" : `es:${text}`)) });
        });
        const queue = new TranslationQueue(offer, fetcher, async () => null, 0);
        const [one, two, same] = await Promise.all([
            queue.translate("hello", "es"),
            queue.translate("bye", "es"),
            queue.translate("hola", "es")
        ]);
        expect(one).toEqual({ kind: "translated", text: "es:hello", detected: null });
        expect(two.kind).toBe("translated");
        expect(same).toEqual({ kind: "same" });
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
        await queue.translate("hello", "es");
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    });

    it("skips a text the browser already reads as the target", async () => {
        const fetcher = vi.fn(async () => json({ charLimit: null }));
        const queue = new TranslationQueue(offer, fetcher, async () => "es", 0);
        expect(await queue.translate("ya está en español", "es")).toEqual({ kind: "same" });
        expect(fetcher.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method)).toBe(false);
    });

    it("fails soft with the route's sentence", async () => {
        const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
            init?.method ? json({ message: "No engine" }, 409) : json({ charLimit: null })
        );
        const queue = new TranslationQueue(offer, fetcher, async () => null, 0);
        expect(await queue.translate("hello", "es")).toEqual({ kind: "failed", message: "No engine" });
    });
});

describe("stored shapes read whole", () => {
    it("reads anything unparsable as off", () => {
        expect(readChatTranslation(null)).toEqual({ incoming: false, outgoing: null });
        expect(readChatTranslation({ incoming: "yes" })).toEqual({ incoming: false, outgoing: null });
        expect(readChatTranslation({ incoming: true, outgoing: "de" })).toEqual({ incoming: true, outgoing: "de" });
        expect(readSentTranslation({ to: "de" })).toBeNull();
    });
});

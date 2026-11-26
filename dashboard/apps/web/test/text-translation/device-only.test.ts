import { describe, expect, it, vi } from "vitest";
import { TranslationQueue, type DeviceEngine } from "@/lib/text-translation/queue";

// The words of an end-to-end encrypted message are translated on the device or
// not at all (docs/chat-e2ee-mls.md, "Sealed translations").

const offer = { appId: "translate", endpoint: "/api/translate", page: "/translate" };

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server(status: Record<string, unknown>) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
        if (!init?.method) return json(status);
        const texts = (JSON.parse(String(init.body)) as { texts: string[] }).texts;
        return json({ texts: texts.map((text) => `srv:${text}`) });
    });
}

const engine = (prefix: string): DeviceEngine => ({
    translate: vi.fn(async (texts: readonly string[]) => ({ texts: texts.map((text) => `${prefix}:${text}`), detected: "en" }))
});

const failing = (): DeviceEngine => ({
    translate: vi.fn(async () => {
        throw new Error("no pair");
    })
});

const posts = (fetcher: ReturnType<typeof server>) => fetcher.mock.calls.filter(([, init]) => init?.method === "POST").length;

const all = { browser: true, local: true, order: ["deepl", "browser", "local"] };

describe("device-only translation", () => {
    it("answers on a device engine even when the server comes first in the order", async () => {
        const fetcher = server(all);
        const queue = new TranslationQueue(offer, fetcher, async () => null, 0, async () => ({ browser: engine("browser"), local: null }));
        expect(await queue.translate("hello there", "es", { deviceOnly: true })).toEqual({ kind: "translated", text: "browser:hello there", detected: "en" });
        expect(posts(fetcher)).toBe(0);
    });

    it("never asks the server when no engine on the device can answer", async () => {
        const fetcher = server(all);
        const queue = new TranslationQueue(offer, fetcher, async () => null, 0, async () => ({ browser: failing(), local: null }));
        expect(await queue.translate("hello there", "es", { deviceOnly: true })).toEqual({ kind: "failed", message: null, onDevice: true });
        expect(posts(fetcher)).toBe(0);
    });

    it("never asks the server when the administrator allows no device engine", async () => {
        const fetcher = server({ browser: false, local: false, order: ["deepl"] });
        const browser = engine("browser");
        const queue = new TranslationQueue(offer, fetcher, async () => null, 0, async () => ({ browser, local: null }));
        expect(await queue.translate("hello there", "es", { deviceOnly: true })).toMatchObject({ kind: "failed", onDevice: true });
        expect(browser.translate).not.toHaveBeenCalled();
        expect(posts(fetcher)).toBe(0);
    });

    it("does not ride a plain request for the same words to the server", async () => {
        const fetcher = server(all);
        const queue = new TranslationQueue(offer, fetcher, async () => null, 50, async () => ({ browser: failing(), local: null }));
        const [sealed, plain] = await Promise.all([
            queue.translate("same words", "es", { deviceOnly: true }),
            queue.translate("same words", "es")
        ]);
        expect(sealed).toMatchObject({ kind: "failed", onDevice: true });
        expect(plain).toEqual({ kind: "translated", text: "srv:same words", detected: null });
        // One request, carrying only the plain one.
        expect(posts(fetcher)).toBe(1);
    });
});

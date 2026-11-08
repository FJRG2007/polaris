import { describe, expect, it, vi } from "vitest";
import { TranslationQueue, type DeviceEngine } from "@/lib/text-translation/queue";

const offer = { appId: "translate", endpoint: "/api/translate", page: "/translate" };

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server(
    status: Record<string, unknown>,
    post = (texts: string[]) => json({ texts: texts.map((text) => `srv:${text}`) })
) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
        if (!init?.method) return json(status);
        return post((JSON.parse(String(init.body)) as { texts: string[] }).texts);
    });
}

const engine = (prefix: string): DeviceEngine & { translate: ReturnType<typeof vi.fn> } => ({
    translate: vi.fn(async (texts: readonly string[]) => ({
        texts: texts.map((text) => `${prefix}:${text}`),
        detected: "en"
    }))
});

const failing = (): DeviceEngine & { translate: ReturnType<typeof vi.fn> } => ({
    translate: vi.fn(async () => {
        throw new Error("no pair");
    })
});

const posts = (fetcher: ReturnType<typeof server>) =>
    fetcher.mock.calls.filter(([, init]) => init?.method === "POST").length;

const all = { browser: true, local: true, order: ["browser", "local", "deepl", "polar"] };

describe("selection translation on the device first", () => {
    it("answers on the browser's translator without asking the server", async () => {
        const fetcher = server(all);
        const browser = engine("browser");
        const local = engine("local");
        const queue = new TranslationQueue(
            offer,
            fetcher,
            async () => null,
            0,
            async () => ({ browser, local })
        );
        expect(await queue.translate("hello", "es")).toEqual({
            kind: "translated",
            text: "browser:hello",
            detected: "en"
        });
        expect(local.translate).not.toHaveBeenCalled();
        expect(posts(fetcher)).toBe(0);
    });

    it("moves on to the local engine, then the server, when one fails", async () => {
        const fetcher = server(all);
        const local = failing();
        const queue = new TranslationQueue(
            offer,
            fetcher,
            async () => null,
            0,
            async () => ({ browser: failing(), local })
        );
        expect(await queue.translate("hello", "es")).toMatchObject({
            kind: "translated",
            text: "srv:hello"
        });
        expect(local.translate).toHaveBeenCalledOnce();
        expect(posts(fetcher)).toBe(1);
    });

    it("follows the administrator's order and skips a device engine they switched off", async () => {
        const local = engine("local");
        const browser = engine("browser");
        const queue = new TranslationQueue(
            offer,
            server({ browser: false, local: true, order: ["browser", "local", "deepl"] }),
            async () => null,
            0,
            async () => ({ browser, local })
        );
        expect(await queue.translate("hello", "es")).toMatchObject({ text: "local:hello" });
        expect(browser.translate).not.toHaveBeenCalled();
    });

    it("asks the server before a device engine ordered after it, and falls back to it", async () => {
        const local = engine("local");
        const fetcher = server({ ...all, order: ["deepl", "local"] }, () =>
            json({ message: "No key" }, 409)
        );
        const queue = new TranslationQueue(
            offer,
            fetcher,
            async () => null,
            0,
            async () => ({ browser: null, local })
        );
        expect(await queue.translate("hello", "es")).toMatchObject({ text: "local:hello" });
        expect(posts(fetcher)).toBe(1);
    });

    it("shows the server's sentence when nothing answers", async () => {
        const fetcher = server(all, () => json({ message: "No engine" }, 409));
        const queue = new TranslationQueue(
            offer,
            fetcher,
            async () => null,
            0,
            async () => {
                throw new Error("bundle missing");
            }
        );
        expect(await queue.translate("hello", "es")).toEqual({
            kind: "failed",
            message: "No engine"
        });
    });

    it("still reaches the server when the app names no order", async () => {
        const fetcher = server({ charLimit: null });
        const queue = new TranslationQueue(
            offer,
            fetcher,
            async () => null,
            0,
            async () => ({ browser: engine("b"), local: null })
        );
        expect(await queue.translate("hello", "es")).toMatchObject({ text: "srv:hello" });
    });

    it("asks the server where its first usable engine sits, not an unusable one", async () => {
        // LibreTranslate first but never set up: the device engines still come before DeepL.
        const fetcher = server({
            browser: false,
            local: true,
            order: ["libretranslate", "local", "deepl"],
            engines: ["deepl"]
        });
        const local = engine("local");
        const queue = new TranslationQueue(
            offer,
            fetcher,
            async () => null,
            0,
            async () => ({ browser: null, local })
        );
        expect(await queue.translate("hello", "es")).toMatchObject({ text: "local:hello" });
        expect(posts(fetcher)).toBe(0);
    });

    it("still asks the server last when no engine there can answer", async () => {
        const fetcher = server(
            { browser: false, local: true, order: ["deepl", "local"], engines: [] },
            () => json({ error: "noEngine", message: "No engine" }, 503)
        );
        const local = failing();
        const queue = new TranslationQueue(
            offer,
            fetcher,
            async () => null,
            0,
            async () => ({ browser: null, local })
        );
        expect(await queue.translate("hello", "es")).toEqual({
            kind: "failed",
            message: "No engine"
        });
        expect(local.translate).toHaveBeenCalled();
        expect(posts(fetcher)).toBe(1);
    });
});

describe("a selection never waits on a first model download", () => {
    it("is answered by the server while the model arrives, and locally once it has", async () => {
        const { createLocalEngine } =
            await import("@polaris-app/translate/src/screens/local-engine");
        let arrive: () => void = () => undefined;
        const arrived = new Promise<void>((resolve) => (arrive = resolve));
        let kept = false;
        const local = createLocalEngine({
            makeWorker: () => {
                const listeners: ((event: { data: unknown }) => void)[] = [];
                return {
                    postMessage(message: unknown) {
                        const { id, name, args } = message as {
                            id: number;
                            name: string;
                            args: unknown[];
                        };
                        const result =
                            name === "translate"
                                ? (args[0] as { texts: { text: string }[] }).texts.map(
                                      ({ text }) => ({
                                          target: { text: `local:${text}` }
                                      })
                                  )
                                : undefined;
                        queueMicrotask(() =>
                            listeners.forEach((listener) => listener({ data: { id, result } }))
                        );
                    },
                    addEventListener(type: string, listener: (event: { data: unknown }) => void) {
                        if (type === "message") listeners.push(listener);
                    },
                    terminate() {}
                };
            },
            loadFile: async (_pair, file, onBytes) => {
                await arrived;
                kept = true;
                onBytes(file.size);
                return new ArrayBuffer(8);
            },
            detect: async () => "en",
            isCached: async () => kept
        });
        const fetcher = server(all);
        const queue = new TranslationQueue(
            offer,
            fetcher,
            async () => null,
            0,
            async () => ({ browser: null, local })
        );
        // The download is held: the answer still comes, from the server.
        expect(await queue.translate("hello", "es")).toMatchObject({
            kind: "translated",
            text: "srv:hello"
        });
        expect(posts(fetcher)).toBe(1);
        arrive();
        for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
        expect(await queue.translate("bye", "es")).toMatchObject({
            kind: "translated",
            text: "local:bye"
        });
        expect(posts(fetcher)).toBe(1);
    });
});

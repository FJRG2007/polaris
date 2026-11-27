/**
 * The sealed search Worker in a real browser: `workerSearchHost` and
 * `search-segment-worker.ts`, bundled as the dashboard ships them, in
 * headless Chromium. A segment sealed here is opened and searched inside the
 * Worker; one under another key, or bound elsewhere, opens to nothing.
 *
 * Skipped when Playwright's Chromium is not on this machine.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as segment from "@/lib/chat/e2ee/search-segment";

const web = fileURLToPath(new URL("../../../", import.meta.url));
const playwright = await import("playwright").catch(() => null);
const runnable = Boolean(playwright && existsSync(playwright.chromium.executablePath()));

const CHANNEL = "0192f5a0-0000-7000-8000-00000000c001";
const msgId = (n: number) => `0192f5a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

type Host = import("@/lib/chat/e2ee/search-segments-client").SegmentSearchHost;

describe.skipIf(!runnable)("the sealed search Worker in headless Chromium", () => {
    let server: Server;
    let base = "";
    let browser: import("playwright").Browser;

    beforeAll(async () => {
        const { build } = await import("esbuild");
        const bundle = async (entry: string) =>
            (await build({ entryPoints: [join(web, entry)], bundle: true, format: "esm", platform: "browser", write: false, tsconfig: join(web, "tsconfig.json"), logLevel: "silent" }))
                .outputFiles[0]!.text;
        const page = await bundle("test/chat/e2ee/support/segment-worker-page.ts");
        const worker = await bundle("src/lib/chat/e2ee/search-segment-worker.ts");
        server = createServer((req, res) => {
            const path = new URL(req.url ?? "/", "http://localhost").pathname;
            if (path === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8"><title>search</title><script type="module" src="/page.js"></script>`);
            if (path === "/page.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(page);
            // Where `new URL("./search-segment-worker.ts", import.meta.url)` points from the page's bundle.
            if (path === "/search-segment-worker.ts") return void res.writeHead(200, { "content-type": "text/javascript" }).end(worker);
            res.writeHead(404).end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        browser = await playwright!.chromium.launch({ headless: true, args: ["--mute-audio"] });
    }, 120_000);

    afterAll(async () => {
        await browser?.close();
        await new Promise((resolve) => server?.close(resolve));
    });

    it("opens and searches a segment inside the Worker, and opens nothing it cannot", async () => {
        const historyKey = new Uint8Array(32).fill(7);
        const key = await segment.indexKey(historyKey, CHANNEL, 5n);
        const binding = { channelId: CHANNEL, epoch: 5n, seq: 0, generation: 0 };
        const index = segment.buildIndex([
            { id: msgId(1), body: "Budget meeting Friday" },
            { id: msgId(2), body: "lunch?" },
            { id: msgId(3), body: "the budget is approved", editedAt: "2026-11-21T09:30:00.000Z" }
        ]);
        const { nonce, ciphertext } = await segment.sealSegment(key, binding, index);
        const other = await segment.indexKey(new Uint8Array(32).fill(8), CHANNEL, 5n);

        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(base);
        await page.waitForFunction(() => "segmentHost" in globalThis);
        const answer = await page.evaluate(
            async ({ key, other, nonce, ciphertext, channelId }) => {
                const host = (globalThis as unknown as { segmentHost: Host }).segmentHost;
                const bytes = (values: number[]) => new Uint8Array(values);
                const binding = { channelId, epoch: "5", seq: 0, generation: 0 };
                const add = (indexKey: number[], at: typeof binding, name: string) =>
                    host.add({ op: "add", key: name, binding: at, indexKey: bytes(indexKey), nonce: bytes(nonce), ciphertext: bytes(ciphertext) });
                const wrongKey = await add(other, binding, "wrong-key");
                const moved = await add(key, { ...binding, seq: 1 }, "moved");
                const opened = await add(key, binding, "right");
                const budget = await host.search("budget", null, 10);
                const elsewhere = await host.search("budget", "0192f5a0-0000-7000-8000-00000000c002", 10);
                await host.clear();
                const cleared = await host.search("budget", null, 10);
                return { wrongKey, moved, opened, budget, elsewhere, cleared };
            },
            { key: [...key], other: [...other], nonce: [...nonce], ciphertext: [...ciphertext], channelId: CHANNEL }
        );
        // It ran in a Worker, not on the page.
        expect(page.workers().map((w) => w.url())).toEqual([`${base}/search-segment-worker.ts`]);
        expect(answer).toMatchObject({ wrongKey: false, moved: false, opened: true, elsewhere: [], cleared: [] });
        expect(answer.budget).toMatchObject([
            { id: msgId(3), channelId: CHANNEL, editedAt: "2026-11-21T09:30:00.000Z" },
            { id: msgId(1), channelId: CHANNEL }
        ]);
        expect(errors).toEqual([]);
        await page.close();
    }, 120_000);
});

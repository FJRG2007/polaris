/**
 * Sealed chat in a real browser: the chat's sealed-chat module, bundled as the
 * dashboard ships it, with the WebAssembly MLS binding and IndexedDB, in
 * headless Chromium, against the real delivery route (over the in-memory
 * tables). Two accounts in one conversation send and open each other's
 * messages; both pages are closed and reopened, and the new pages open every
 * message again from what the browser kept and still send.
 *
 * Skipped when the staged binding (public/core-rs/mls) or Playwright's
 * Chromium is not on this machine.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
    tables: {} as Record<string, Row[]>,
    members: new Set<string>(),
    seq: 0n
}));
// The account each request is for, read by the session stand-in.
vi.mock("@/lib/session", async () => {
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const who = new AsyncLocalStorage<string>();
    return { who, backgroundUser: async () => (who.getStore() ? { id: who.getStore() } : null) };
});
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/messages", () => ({
    send: async (actor: { id: string }, input: { channelId: string; body: string; clientKey?: string }, ...rest: unknown[]) => {
        const rows = (state.tables.chatMessage ??= []);
        const earlier = rows.find((r) => r.authorId === actor.id && r.clientKey === input.clientKey);
        if (earlier) return earlier.id;
        const id = crypto.randomUUID();
        rows.push({ id, channelId: input.channelId, authorId: actor.id, clientKey: input.clientKey, body: input.body, deletedAt: null, expiresAt: null, audience: [], replyToId: (rest[1] as { messageId?: string } | null)?.messageId ?? null, ...(rest[5] as Row) });
        return id;
    }
}));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (actor: { id: string }, channelId: string) => (state.members.has(`${actor.id}:${channelId}`) ? { id: channelId } : null),
    conversationAudience: async (actor: { id: string }, channelId: string) =>
        state.members.has(`${actor.id}:${channelId}`)
            ? [...state.members].filter((m) => m.endsWith(`:${channelId}`)).map((m) => m.slice(0, m.indexOf(":")))
            : null
}));
vi.mock("@polaris/db", async () => ({ prisma: (await import("./support/mls-tables")).memoryPrisma(state) }));

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "44444444-4444-4444-8444-444444444444";

const web = fileURLToPath(new URL("../../../", import.meta.url));
const assets = join(web, "public", "core-rs", "mls");
const playwright = await import("playwright").catch(() => null);
const runnable = Boolean(playwright && existsSync(join(assets, "manifest.json")) && existsSync(playwright.chromium.executablePath()));
// CI installs both (dashboard-ci.yml, web-mls-native) and asks for them, so a
// missing one fails there instead of skipping quietly.
if (process.env.POLARIS_REQUIRE_SEALED_BROWSER && !runnable) throw new Error(`the sealed browser test needs the staged MLS binding in ${assets} and Playwright's Chromium`);

type Sealed = typeof import("@/lib/chat/e2ee/sealed-chat");
type Page = import("playwright").Page;
type Context = import("playwright").BrowserContext;

describe.skipIf(!runnable)("sealed chat in headless Chromium", () => {
    let server: Server;
    let base = "";
    let browser: import("playwright").Browser;
    const keys = new Map<string, number[]>();

    beforeAll(async () => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
        state.members = new Set([`${ALICE}:${CHANNEL}`, `${BOB}:${CHANNEL}`]);
        const accountKeys = await import("@polaris/chat-crypto/account-key");
        for (const userId of [ALICE, BOB]) {
            const ak = accountKeys.generateAccountKey();
            const { signPublicKey, hpkePublicKey } = await accountKeys.accountPublicKeys(ak);
            (state.tables.chatAccountKey ??= []).push({ userId, akVersion: 1, signPublicKey: Buffer.from(signPublicKey), hpkePublicKey: Buffer.from(hpkePublicKey) });
            keys.set(userId, [...ak]);
        }
        const { build } = await import("esbuild");
        const bundle = await build({
            entryPoints: [join(web, "test/chat/e2ee/support/sealed-page.ts")],
            bundle: true,
            format: "esm",
            platform: "browser",
            write: false,
            tsconfig: join(web, "tsconfig.json"),
            logLevel: "silent",
            plugins: [
                {
                    name: "account-key-stand-in",
                    setup(on) {
                        on.onResolve({ filter: /account-key-client$/ }, () => ({ path: join(web, "test/chat/e2ee/support/sealed-page-account.ts") }));
                    }
                }
            ]
        });
        const script = bundle.outputFiles[0].text;
        const { handleMls } = await import("@/lib/chat/e2ee/mls-handler");
        const { who } = (await import("@/lib/session")) as unknown as { who: import("node:async_hooks").AsyncLocalStorage<string> };
        server = createServer(async (req, res) => {
            try {
                const url = new URL(req.url ?? "/", "http://localhost");
                if (url.pathname === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8"><title>sealed</title><script type="module" src="/page.js"></script>`);
                if (url.pathname === "/page.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(script);
                if (url.pathname.startsWith("/core-rs/mls/")) {
                    const file = normalize(join(assets, url.pathname.slice("/core-rs/mls/".length)));
                    if (!file.startsWith(assets + sep)) return void res.writeHead(404).end();
                    const type = file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".js") ? "text/javascript" : "application/json";
                    return void res.writeHead(200, { "content-type": type }).end(await readFile(file));
                }
                if (url.pathname === "/api/e2ee/mls" && req.method === "POST") {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) chunks.push(chunk as Buffer);
                    const user = /(?:^|; )who=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
                    const request = new Request(`${base}/api/e2ee/mls`, { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: Buffer.concat(chunks) });
                    const response = await who.run(user ?? "", () => handleMls(request));
                    return void res.writeHead(response.status, { "content-type": "application/json" }).end(Buffer.from(await response.arrayBuffer()));
                }
                res.writeHead(404).end();
            } catch (caught) {
                console.error(caught);
                res.writeHead(500).end();
            }
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

    async function account(userId: string): Promise<Context> {
        const context = await browser.newContext();
        await context.addCookies([{ name: "who", value: userId, url: base }]);
        await context.addInitScript((key) => Object.assign(globalThis, { accountKey: key }), keys.get(userId)!);
        return context;
    }

    async function open(context: Context, userId: string): Promise<Page> {
        const page = await context.newPage();
        page.on("pageerror", (error) => console.error(`[${userId.slice(0, 4)}] ${error.message}`));
        await page.goto(base);
        await page.waitForFunction(() => "sealed" in globalThis);
        await page.evaluate((id) => (globalThis as unknown as { sealed: Sealed }).sealed.configureSealedChat(id), userId);
        return page;
    }

    const send = (page: Page, body: string) =>
        page.evaluate(
            ([channelId, text]) => (globalThis as unknown as { sealed: Sealed }).sealed.sendSealedMessage({ channelId, clientKey: crypto.randomUUID(), body: text }),
            [CHANNEL, body] as const
        );
    const read = (page: Page, ids: string[]) =>
        page.evaluate(
            async ([channelId, wanted]) => Object.fromEntries([...(await (globalThis as unknown as { sealed: Sealed }).sealed.openSealed(channelId, wanted))].map(([id, c]) => [id, c?.body ?? null])),
            [CHANNEL, ids] as const
        );

    it("sends, opens, and opens again after both pages restart", async () => {
        const [aliceAccount, bobAccount] = await Promise.all([account(ALICE), account(BOB)]);
        let alice = await open(aliceAccount, ALICE);
        let bob = await open(bobAccount, BOB);

        const first = await send(alice, "hello from alice");
        expect(await read(bob, [first])).toEqual({ [first]: "hello from alice" });
        const second = await send(bob, "hi alice");
        expect(await read(alice, [first, second])).toEqual({ [first]: "hello from alice", [second]: "hi alice" });

        const stored = state.tables.chatMessage.filter((r) => r.id === first || r.id === second);
        expect(stored.every((r) => r.body === "" && r.e2eeEpoch !== undefined)).toBe(true);

        await Promise.all([alice.close(), bob.close()]);
        alice = await open(aliceAccount, ALICE);
        bob = await open(bobAccount, BOB);
        const all = { [first]: "hello from alice", [second]: "hi alice" };
        expect(await read(alice, [first, second])).toEqual(all);
        expect(await read(bob, [first, second])).toEqual(all);

        const third = await send(alice, "still here");
        expect(await read(bob, [third])).toEqual({ [third]: "still here" });
        const fourth = await send(bob, "me too");
        expect(await read(alice, [fourth])).toEqual({ [fourth]: "me too" });
    }, 120_000);
});

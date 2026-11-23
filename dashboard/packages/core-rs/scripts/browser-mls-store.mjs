/**
 * MLS state in IndexedDB survives a killed page (docs/rust-core-plan.md, E2).
 * Two devices of the real wasm MlsMember persist through IndexedDbMlsStore in
 * headless Chromium and Firefox; the page is killed (a renderer crash in
 * Chromium, a close with no unload in Firefox) between an operation and its
 * commit, after the commit, and while the commit is still in flight. A new page
 * restores both devices from IndexedDB and must find either the operation never
 * happened (no pending commit, no outbox) or the operation and its message in
 * the outbox, which it resends; then the group still talks.
 *
 *   npm run build -w @polaris/core-rs && npm run build:rust -w @polaris/core-rs -- --only wasm
 *   npm run test:browsers:mls -w @polaris/core-rs [-- chromium firefox webkit]
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";
import { join, normalize, resolve, sep } from "node:path";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const ENGINES = { chromium, firefox, webkit };
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };
const RACES = 6;

for (const need of ["dist/mls-store.js", "wasm-mls/polaris_core_mls.js", "wasm-mls/polaris_core_mls_bg.wasm"])
    if (!existsSync(join(packageDir, need))) throw new Error(`${need} is missing: run npm run build and npm run build:rust -- --only wasm first`);

const PAGE = `<!doctype html><meta charset="utf-8"><title>core-rs mls store</title><p>mls store</p>
<script type="module">
import { IndexedDbMlsStore } from "/pkg/dist/mls-store.js";
import init, { MlsMember } from "/pkg/wasm-mls/polaris_core_mls.js";
await init({ module_or_path: "/pkg/wasm-mls/polaris_core_mls_bg.wasm" });
const SUITE = 0x004f;
const NAMES = ["alice", "bob"];
const enc = new TextEncoder();
const dec = new TextDecoder();
const GROUP = enc.encode("polaris/chat/indexeddb");
const seed = () => crypto.getRandomValues(new Uint8Array(32));
const devices = {};
const persist = (name, messages = []) => devices[name].store.commit(devices[name].member.storeChanges(), messages);
const epoch = (name) => Number(devices[name].member.epoch(GROUP));
window.mls = {
    async setup() {
        localStorage.clear();
        for (const name of NAMES) {
            await IndexedDbMlsStore.destroy(name);
            const member = new MlsMember(enc.encode(name), SUITE, seed());
            localStorage.setItem("spk:" + name, JSON.stringify([...member.signaturePublicKey()]));
            devices[name] = { store: await IndexedDbMlsStore.open(name), member, outbox: [] };
            await persist(name);
        }
        const keyPackage = devices.bob.member.keyPackage();
        await persist("bob");
        devices.alice.member.createGroup(GROUP);
        const out = devices.alice.member.addMembers(GROUP, [keyPackage]);
        devices.alice.member.mergePendingCommit(GROUP);
        await persist("alice");
        devices.bob.member.joinByWelcome(out.welcome);
        await persist("bob");
        return { alice: epoch("alice"), bob: epoch("bob") };
    },
    // What a host does when the page starts: every device from its store.
    async boot() {
        for (const name of NAMES) {
            const store = await IndexedDbMlsStore.open(name);
            const snapshot = await store.load();
            const signaturePublicKey = Uint8Array.from(JSON.parse(localStorage.getItem("spk:" + name)));
            const member = MlsMember.restore(enc.encode(name), SUITE, seed(), snapshot.keys, snapshot.values, signaturePublicKey);
            devices[name] = { store, member, outbox: snapshot.outbox };
        }
    },
    // alice self-updates; "none" never commits, "await" commits with the
    // commit in the outbox, "race" starts that commit and returns at once.
    operate(mode) {
        const out = devices.alice.member.selfUpdate(GROUP);
        if (mode === "none") return;
        const committing = persist("alice", [out.commit]);
        if (mode === "race") return void committing.catch(() => {});
        return committing.then(() => undefined);
    },
    // Resend the outbox (the delivery service accepts it), then talk.
    async settle() {
        const alice = devices.alice;
        const before = { alice: epoch("alice"), bob: epoch("bob"), outbox: alice.outbox.length };
        for (const entry of alice.outbox) {
            devices.bob.member.process(GROUP, entry.message);
            await persist("bob");
            alice.member.mergePendingCommit(GROUP);
            await persist("alice");
            await alice.store.sent(entry.id);
        }
        // An empty outbox must mean no commit is pending either.
        let strayPending = false;
        if (!alice.outbox.length) {
            try {
                alice.member.mergePendingCommit(GROUP);
                strayPending = true;
            } catch {}
        }
        alice.outbox = [];
        const text = "after the restart " + crypto.randomUUID();
        const sealed = alice.member.encrypt(GROUP, enc.encode(text));
        await persist("alice");
        const opened = dec.decode(devices.bob.member.process(GROUP, sealed).plaintext);
        await persist("bob");
        const left = (await alice.store.load()).outbox.length;
        return { before, strayPending, roundTrip: opened === text, left, after: { alice: epoch("alice"), bob: epoch("bob") } };
    }
};
window.mlsReady = true;
</script>`;

const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    if (!url.pathname.startsWith("/pkg/")) return res.writeHead(404).end();
    const path = normalize(join(packageDir, url.pathname.slice(5)));
    if (!path.startsWith(resolve(packageDir) + sep)) return res.writeHead(403).end();
    try {
        const body = await readFile(path);
        res.writeHead(200, { "content-type": TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream" }).end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

async function openPage(context, errors) {
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.waitForFunction(() => window.mlsReady === true, null, { timeout: 30000 }).catch(() => {
        throw new Error(`the page never became ready: ${errors.join("; ") || "no error reported"}`);
    });
    return page;
}

/** End the page with no chance to finish anything it started. */
async function kill(name, page) {
    if (name === "chromium") {
        const cdp = await page.context().newCDPSession(page);
        const crashed = page.waitForEvent("crash");
        cdp.send("Page.crash").catch(() => {});
        await crashed;
    }
    await page.close({ runBeforeUnload: false });
}

/** Restart in a new page and check the state is one of the two allowed ones. */
async function restart(context, errors, expectOutbox) {
    const page = await openPage(context, errors);
    await page.evaluate(() => window.mls.boot());
    const r = await page.evaluate(() => window.mls.settle());
    const problems = [];
    const { before, after } = r;
    if (expectOutbox !== undefined && before.outbox !== expectOutbox) problems.push(`outbox held ${before.outbox}, expected ${expectOutbox}`);
    if (before.outbox > 1) problems.push(`outbox held ${before.outbox} messages for one operation`);
    if (before.alice !== before.bob) problems.push(`restored at different epochs: alice ${before.alice}, bob ${before.bob}`);
    if (r.strayPending) problems.push("a pending commit was persisted without its outbox message");
    if (after.alice !== after.bob) problems.push(`epochs diverged after settling: alice ${after.alice}, bob ${after.bob}`);
    if (after.alice !== before.alice + before.outbox) problems.push(`epoch ${after.alice} after settling from ${before.alice} with ${before.outbox} resent`);
    if (!r.roundTrip) problems.push("bob could not read alice after the restart");
    if (r.left !== 0) problems.push(`${r.left} messages left in the outbox after sending`);
    return { page, problems, resent: before.outbox };
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox"];
let failed = false;
try {
    for (const name of wanted) {
        const engine = ENGINES[name];
        if (!engine) throw new Error(`unknown browser ${name}`);
        const browser = await engine.launch({ headless: true, args: name === "chromium" ? ["--mute-audio"] : [] });
        const problems = [];
        let resent = 0;
        try {
            const context = await browser.newContext();
            const errors = [];
            let page = await openPage(context, errors);
            const start = await page.evaluate(() => window.mls.setup());
            if (start.alice !== 1 || start.bob !== 1) problems.push(`setup ended at ${JSON.stringify(start)}`);
            const cases = [
                ["killed before the commit", "none", 0],
                ["killed after the commit", "await", 1],
                ...Array.from({ length: RACES }, (_, i) => [`killed during the commit (${i + 1})`, "race", undefined])
            ];
            for (const [label, mode, expectOutbox] of cases) {
                await page.evaluate((m) => window.mls.operate(m), mode);
                await kill(name, page);
                const next = await restart(context, errors, expectOutbox);
                page = next.page;
                if (mode === "race") resent += next.resent;
                problems.push(...next.problems.map((p) => `${label}: ${p}`));
            }
            problems.push(...errors.map((e) => `page error: ${e}`));
            await context.close();
        } catch (error) {
            problems.push(String(error?.stack ?? error));
        } finally {
            await browser.close();
        }
        if (problems.length) {
            failed = true;
            process.stdout.write(`[browser-mls-store] ${name}: FAIL\n  ${problems.join("\n  ")}\n`);
        } else
            process.stdout.write(
                `[browser-mls-store] ${name}: consistent after ${RACES + 2} kills (${resent}/${RACES} in-flight commits had landed and were resent)\n`
            );
    }
} finally {
    server.close();
}
process.exit(failed ? 1 : 0);

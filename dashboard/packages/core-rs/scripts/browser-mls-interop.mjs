/**
 * MLS across a real browser and the server's Node binding (docs/rust-core-plan.md,
 * E3). The page runs the wasm chunk a person's browser loads; this process runs
 * the napi binding the server uses for the members it holds itself (Polar, a
 * webhook - docs/chat-e2ee-proposal.md section 7). Every MLS message crosses
 * between them as bytes, the way the delivery service carries it: a group
 * created on the server takes a browser member by Welcome, the browser commits
 * an addition of another server member, both sides talk, the browser updates its
 * leaf, the server removes the browser member, and the exporter (call keys) and
 * epoch authenticator agree everywhere. Both suites, in each engine asked for.
 *
 *   npm run build:rust -w @polaris/core-rs        (node and wasm)
 *   npm run test:browsers:mls-interop -w @polaris/core-rs [-- chromium firefox webkit]
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium, firefox, webkit } from "playwright";
import { join, normalize, resolve, sep } from "node:path";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const ENGINES = { chromium, firefox, webkit };
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };
const SUITES = [0x004f, 0x0001];

const report = process.report.getReport();
const musl = process.platform === "linux" && !report.header?.glibcVersionRuntime;
const abi = process.platform === "win32" ? "-msvc" : process.platform === "linux" ? (musl ? "-musl" : "-gnu") : "";
const nativePath = join(packageDir, "native", `polaris-core.${process.platform}-${process.arch}${abi}.node`);
for (const need of [nativePath, join(packageDir, "wasm-mls/polaris_core_mls.js"), join(packageDir, "wasm-mls/polaris_core_mls_bg.wasm")])
    if (!existsSync(need)) throw new Error(`${need} is missing: run npm run build:rust first`);
const { MlsMember } = createRequire(import.meta.url)(nativePath);

// Bytes and bigints do not survive page.evaluate as themselves, so both sides
// tag them. The page gets these same two functions' source.
function pack(v) {
    if (v instanceof Uint8Array) return { $u8: Array.from(v) };
    if (typeof v === "bigint") return { $big: v.toString() };
    if (Array.isArray(v)) return v.map(pack);
    if (v && typeof v === "object") {
        // A wasm-bindgen result is a class whose fields are prototype getters.
        const proto = Object.getPrototypeOf(v);
        const getters =
            proto && proto !== Object.prototype
                ? Object.entries(Object.getOwnPropertyDescriptors(proto))
                      .filter(([, d]) => d.get)
                      .map(([k]) => k)
                : [];
        return Object.fromEntries([...Object.keys(v).filter((k) => !k.startsWith("__")), ...getters].map((k) => [k, pack(v[k])]));
    }
    return v;
}
function unpack(v) {
    if (Array.isArray(v)) return v.map(unpack);
    if (v && typeof v === "object") {
        if ("$u8" in v) return Uint8Array.from(v.$u8);
        if ("$big" in v) return BigInt(v.$big);
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)]));
    }
    return v;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>core-rs mls interop</title><p>mls interop</p>
<script type="module">
import init, { MlsMember } from "/pkg/wasm-mls/polaris_core_mls.js";
await init({ module_or_path: "/pkg/wasm-mls/polaris_core_mls_bg.wasm" });
${pack.toString()}
${unpack.toString()}
const members = {};
window.mls = {
    create(name, suite) {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        members[name] = new MlsMember(new TextEncoder().encode(name), suite, seed);
    },
    call(name, method, args) {
        try {
            return { ok: pack(members[name][method](...unpack(args))) };
        } catch (error) {
            return { error: { code: error?.code, message: String(error?.message ?? error) } };
        }
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

const enc = new TextEncoder();
const dec = new TextDecoder();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A member living in the page, called like a napi one but asynchronously. */
function pageMember(page, name) {
    return new Proxy(
        {},
        {
            get: (_, method) => async (...args) => {
                const r = await page.evaluate(([n, m, a]) => window.mls.call(n, m, a), [name, method, pack(args)]);
                if (r.error) throw Object.assign(new Error(`${name}.${String(method)}: ${r.error.message}`), { code: r.error.code });
                return unpack(r.ok);
            }
        }
    );
}

/** One group's life with server-held (napi) and browser (wasm) members. */
async function scenario(page, suite) {
    const problems = [];
    const check = (ok, what) => ok || problems.push(what);
    const seed = () => crypto.getRandomValues(new Uint8Array(32));
    const group = enc.encode(`interop-${suite}`);
    await page.evaluate(([s]) => window.mls.create("bob", s), [suite]);
    const polar = new MlsMember(enc.encode("polar"), suite, seed());
    const hook = new MlsMember(enc.encode("webhook"), suite, seed());
    const bob = pageMember(page, "bob");

    // The server creates the group and the browser joins by Welcome.
    polar.createGroup(group);
    const added = polar.addMembers(group, [await bob.keyPackage()]);
    polar.mergePendingCommit(group);
    check(same(await bob.joinByWelcome(added.welcome), group), "the browser joined another group id");
    const toBob = await bob.process(group, polar.encrypt(group, enc.encode("from the server")));
    check(dec.decode(toBob.plaintext) === "from the server" && toBob.senderLeaf === 0, "server -> browser message");
    const fromBob = polar.process(group, await bob.encrypt(group, enc.encode("from the browser")));
    check(dec.decode(fromBob.plaintext) === "from the browser", "browser -> server message");

    // The browser commits a server-held member in; the server takes its commit.
    const byBob = await bob.addMembers(group, [hook.keyPackage()]);
    await bob.mergePendingCommit(group);
    check(polar.process(group, byBob.commit).kind === "commit", "the server refused the browser's commit");
    hook.joinByWelcome(byBob.welcome);
    const fromHook = hook.encrypt(group, enc.encode("automation"));
    check(dec.decode((await bob.process(group, fromHook)).plaintext) === "automation", "webhook -> browser");
    check(dec.decode(polar.process(group, fromHook).plaintext) === "automation", "webhook -> server");

    // The browser updates its leaf; everyone lands on the same epoch.
    const update = await bob.selfUpdate(group);
    await bob.mergePendingCommit(group);
    polar.process(group, update.commit);
    hook.process(group, update.commit);
    const auth = await bob.epochAuthenticator(group);
    check(same(auth, polar.epochAuthenticator(group)) && same(auth, hook.epochAuthenticator(group)), "epoch authenticators differ");
    const ctx = enc.encode("call");
    const callKey = await bob.exportSecret(group, "polaris call", ctx, 32);
    check(same(callKey, polar.exportSecret(group, "polaris call", ctx, 32)), "exporter secrets differ");
    check((await bob.members(group)).length === 3 && polar.members(group).length === 3, "member lists differ");

    // The server removes the browser member, which learns it was removed.
    const removed = polar.removeMembers(group, [await bob.ownLeaf(group)]);
    polar.mergePendingCommit(group);
    hook.process(group, removed.commit);
    check((await bob.process(group, removed.commit)).active === false, "the removed browser member still thinks it is in");
    const after = polar.encrypt(group, enc.encode("bob is gone"));
    check(dec.decode(hook.process(group, after).plaintext) === "bob is gone", "after removal");
    const refused = await bob.process(group, after).then(
        () => null,
        (e) => e
    );
    check(refused && /^Mls/.test(refused.code ?? ""), "a removed browser member read a later message");
    return problems;
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox", "webkit"];
let failed = false;
try {
    for (const name of wanted) {
        const engine = ENGINES[name];
        if (!engine) throw new Error(`unknown browser ${name}`);
        const browser = await engine.launch({ headless: true, args: name === "chromium" ? ["--mute-audio"] : [] });
        const problems = [];
        try {
            const page = await browser.newPage();
            const errors = [];
            page.on("pageerror", (e) => errors.push(e.message));
            await page.goto(origin);
            await page.waitForFunction(() => window.mlsReady === true, null, { timeout: 30000 });
            for (const suite of SUITES)
                problems.push(...(await scenario(page, suite)).map((p) => `0x${suite.toString(16).padStart(4, "0")}: ${p}`));
            problems.push(...errors.map((e) => `page error: ${e}`));
        } catch (error) {
            problems.push(String(error?.stack ?? error));
        } finally {
            await browser.close();
        }
        if (problems.length) {
            failed = true;
            process.stdout.write(`[browser-mls-interop] ${name}: FAIL\n  ${problems.join("\n  ")}\n`);
        } else process.stdout.write(`[browser-mls-interop] ${name}: napi and wasm members agree on both suites\n`);
    }
} finally {
    server.close();
}
process.exit(failed ? 1 : 0);

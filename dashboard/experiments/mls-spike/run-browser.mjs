// Bundles the entries, serves them on 127.0.0.1 (a secure context, so WebCrypto works) and runs
// each one in headless Chromium and WebKit through playwright-core. Usage:
//   node run-browser.mjs <engine: chromium|webkit> <entry: ts-mls|openmls> <sizes> [cpuThrottle]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright-core";

const root = fileURLToPath(new URL(".", import.meta.url));
const [engine = "chromium", entry = "ts-mls", sizes = "2,50", throttle = "1"] = process.argv.slice(2);
await build({ entryPoints: [join(root, "web/ts-mls.ts")], bundle: true, minify: true, format: "esm", target: "es2022", outfile: join(root, "dist/ts-mls.js"), logLevel: "error" });

const types = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };
const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/") {
        const script = entry === "openmls" ? "/web/openmls.js" : "/dist/ts-mls.js";
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8"><script type="module" src="${script}"></script>`);
        return;
    }
    const file = normalize(join(root, url.pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
        res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// WEBKIT_PATH points at an installed Playwright WebKit build when the pinned revision is not downloaded.
const browser = await (engine === "webkit" ? webkit : chromium).launch({ headless: true, executablePath: engine === "webkit" ? process.env.WEBKIT_PATH : undefined, args: engine === "webkit" ? [] : ["--mute-audio"] });
const page = await browser.newPage();
if (engine !== "webkit" && Number(throttle) > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(throttle) });
}
await page.goto(`http://127.0.0.1:${port}/?sizes=${sizes}`);
await page.waitForFunction(() => window.__done, null, { timeout: 0, polling: 500 });
const rows = await page.evaluate(() => window.__done);
console.log(JSON.stringify({ engine, version: browser.version(), entry, throttle: Number(throttle) }));
for (const row of rows) console.log(JSON.stringify(row));
await browser.close();
server.close();

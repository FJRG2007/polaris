/**
 * Picture every README scene: each theme, each language, a desktop and a phone
 * frame, saved as WebP at fixed paths the README links to.
 *
 * The page built by `build.mjs` is served from a local server - no Polaris runs
 * and nothing is called outside this machine - and a headless Chromium takes the
 * pictures with its clock frozen at the scene's moment, so a run on Monday and a
 * run on Friday draw the same "5 minutes ago". A scene with an animation is
 * stepped frame by frame under that frozen clock (Playwright's clock API) and
 * the frames are joined into an animated WebP with sharp, the same way projects
 * that record their UI for a README script interactions instead of filming them.
 *
 * A scene is refused, and the run fails, when the page logged an error, threw,
 * or asked for an action or an API route the scene did not answer: a picture of
 * a screen that was missing its data is a picture of a bug.
 *
 *   node scripts/readme-media/capture.mjs [--only chat,tasks] [--quick] [--check]
 *
 * `--check` renders every variant and saves nothing - the test the workflow and
 * a developer run before trusting the pictures.
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { LOCALES, MEDIA_DIR, MOMENT, THEMES, VIEWPORTS, mediaName } from "./variants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const site = join(here, "out", "site");
const output = resolve(root, "..", MEDIA_DIR);
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright");
const sharp = require("sharp");

const SCALE = 2;

const args = process.argv.slice(2);
const check = args.includes("--check");
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? new Set(args[onlyAt + 1].split(",")) : null;
/** One variant (dark, English, desktop) instead of all eight: for working on a scene. */
const quick = args.includes("--quick");

const TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".json": "application/json"
};

const PIXEL = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
);

/** Where the mail list asks for a sender's picture. Nobody in a fixture has one. */
const FACELESS = "/api/mail/face/";

/** The built page, and the app's public folder at the root the way Next serves it. */
function serve() {
    const server = createServer((req, res) => {
        const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
        // Somebody with no picture gets a transparent pixel from the real route,
        // and the initials the component drew show through. Same here.
        if (path.startsWith("/api/avatar/")) {
            res.writeHead(200, { "content-type": "image/png" }).end(PIXEL);
            return;
        }
        // A sender with no picture is a 404 from the real route, and the list
        // draws their initials. Same here; see FACELESS below.
        if (path.startsWith(FACELESS)) {
            res.writeHead(404).end();
            return;
        }
        const candidates = [
            join(site, path === "/" ? "index.html" : path),
            join(site, "public", path)
        ];
        const file = candidates.find((candidate) => {
            const inside = normalize(candidate).startsWith(site + sep);
            return inside && existsSync(candidate) && statSync(candidate).isFile();
        });
        if (!file) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
        res.end(readFileSync(file));
    });
    return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

async function scenes(page, base) {
    const thrown = [];
    page.on("pageerror", (error) => thrown.push(error.message));
    page.on("console", (message) => message.type() === "error" && thrown.push(message.text()));
    await page.goto(`${base}/index.html?scene=__list__`);
    try {
        await page.waitForFunction(() => Array.isArray(window.__SCENE_LIST__), null, {
            timeout: 30000
        });
    } catch {
        throw new Error(`the scene page did not load: ${thrown.join(" | ")}`);
    }
    return page.evaluate(() => window.__SCENE_LIST__);
}

/** Wait until the screen stops changing: data answered, fonts in, no spinner. */
async function settle(page) {
    await page.waitForFunction(() => window.__scene?.ready === true, null, { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(2000);
    await page.waitForTimeout(300);
}

async function picture(page, scene, viewport) {
    const shot = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, ...VIEWPORTS[viewport] }
    });
    return sharp(shot);
}

async function run() {
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ args: ["--mute-audio", "--font-render-hinting=none"] });
    const failures = [];
    let saved = 0;
    try {
        const lister = await browser.newPage();
        const ids = (await scenes(lister, base)).filter((scene) => !only || only.has(scene.id));
        await lister.close();
        if (ids.length === 0) throw new Error("no scenes to capture");
        if (!check) mkdirSync(output, { recursive: true });

        for (const scene of ids) {
            for (const [short, locale] of Object.entries(quick ? { en: LOCALES.en } : LOCALES)) {
                for (const theme of quick ? ["dark"] : THEMES) {
                    for (const viewport of quick ? ["desktop"] : Object.keys(VIEWPORTS)) {
                        const file = mediaName(scene.id, theme, short, viewport);
                        const name = file.replace(/\.webp$/, "");
                        const context = await browser.newContext({
                            viewport: VIEWPORTS[viewport],
                            deviceScaleFactor: SCALE,
                            colorScheme: theme,
                            locale,
                            timezoneId: "Europe/Madrid",
                            reducedMotion: "reduce"
                        });
                        const problems = [];
                        // Nothing leaves this machine: a request to another site is
                        // one the scene forgot to answer, and the picture would
                        // depend on whatever that site said today.
                        await context.route(
                            (url) => url.origin !== base,
                            (route) => {
                                problems.push(`left the page: ${route.request().url()}`);
                                return route.abort();
                            }
                        );
                        const page = await context.newPage();
                        page.on("console", (message) => {
                            if (
                                message.type() === "error" &&
                                !message.text().startsWith("Failed to load resource")
                            ) {
                                problems.push(`console: ${message.text()}`);
                            }
                        });
                        page.on("pageerror", (error) => problems.push(`thrown: ${error.message}`));
                        page.on("response", (response) => {
                            if (
                                response.status() >= 400 &&
                                !new URL(response.url()).pathname.startsWith(FACELESS)
                            )
                                problems.push(`${response.status()}: ${response.url()}`);
                        });
                        await page.clock.install({ time: MOMENT });
                        await page.goto(
                            `${base}/index.html?scene=${scene.id}&theme=${theme}&locale=${locale}`
                        );
                        try {
                            await settle(page);
                            await page.evaluate(() => window.__scene.prepare());
                            await page.clock.runFor(2000);
                            await page.waitForTimeout(300);
                        } catch (caught) {
                            problems.push(`never settled: ${caught.message}`);
                        }
                        const missing = await page.evaluate(() => globalThis.__MISSING__ ?? []);
                        for (const what of new Set(missing)) problems.push(`not answered: ${what}`);
                        if (problems.length > 0) {
                            failures.push({ name, problems });
                            await context.close();
                            continue;
                        }
                        if (!check) {
                            const frames = await page.evaluate(() => window.__scene.frames);
                            if (frames <= 1 || viewport === "mobile") {
                                const image = await picture(page, scene, viewport);
                                writeFileSync(
                                    join(output, file),
                                    await image.webp({ quality: 82 }).toBuffer()
                                );
                            } else {
                                const shots = [];
                                const delays = [];
                                for (let index = 0; index < frames; index++) {
                                    await page.evaluate((i) => window.__scene.step(i), index);
                                    await page.clock.runFor(
                                        await page.evaluate((i) => window.__scene.advance(i), index)
                                    );
                                    await page.waitForTimeout(120);
                                    shots.push(
                                        await (await picture(page, scene, viewport))
                                            .resize(VIEWPORTS[viewport].width)
                                            .png()
                                            .toBuffer()
                                    );
                                    delays.push(
                                        await page.evaluate((i) => window.__scene.hold(i), index)
                                    );
                                }
                                const animated = sharp(shots, { join: { animated: true } }).webp({
                                    quality: 75,
                                    delay: delays,
                                    loop: 0
                                });
                                writeFileSync(join(output, file), await animated.toBuffer());
                            }
                            saved++;
                        }
                        await context.close();
                    }
                }
            }
        }
    } finally {
        await browser.close();
        server.close();
    }
    for (const failure of failures) {
        process.stderr.write(
            `[readme-media] ${failure.name}\n${failure.problems.map((line) => `    ${line}`).join("\n")}\n`
        );
    }
    if (failures.length > 0) process.exit(1);
    process.stdout.write(
        `[readme-media] ${check ? "checked" : `saved ${saved} pictures to ${output}`}\n`
    );
}

await run();

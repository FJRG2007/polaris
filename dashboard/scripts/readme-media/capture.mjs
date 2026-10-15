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
 *   node scripts/readme-media/capture.mjs [--only chat,tasks] [--quick] [--check] [--jobs 4]
 *
 * `--check` renders every variant, walking each animated one through its frames,
 * and saves nothing - the test a developer runs before trusting the pictures, and
 * the workflow's first step before any picture is replaced.
 *
 * Variants are taken several at a time (`--jobs`, one per core but one and at
 * most four by default, so the frozen-clock waits still get a core), each
 * in a browser context of its own with its own frozen clock. One at a time, the
 * full set took longer than the workflow's limit and no run ever finished.
 */

import { availableParallelism } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { LOCALES, MEDIA_DIR, MOMENT, THEMES, VIEWPORTS, mediaName } from "./variants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const site = join(here, "out", "site");
/** The invented people's faces, by account id; see faces/LICENSE.md. */
const faces = join(here, "faces");
/** Files the fixtures send - pictures, a clip's still, a space's emoji - by the
 *  fixture id the message names them by; see media/LICENSE.md. */
const media = join(here, "media");
/** The routes that serve such a file, with the id where the route puts it. An
 *  organization's or a space's picture is its mark, in the same folder. */
const MEDIA_ROUTES = [
    /^\/api\/chat\/attachments\/([\w-]+)$/,
    /^\/api\/chat\/emoji\/([\w-]+)$/,
    /^\/api\/chat\/links\/([\w-]+)\/image$/,
    /^\/api\/avatar\/org\/([\w-]+)$/,
    /^\/api\/avatar\/chat\/space\/([\w-]+)$/
];
/** Where a fixture camera (`fixtures/call.ts`) fetches the person it films. Not
 *  a route of the app: only the harness's own canvas asks for it. */
const CAMERA = /^\/readme-media\/camera\/([\w-]+)$/;
/** Where the Game servers app serves its staged Minecraft item pictures. */
const ITEM_ICON = /^\/api\/app-bundles\/game-servers\/current\/assets\/mcicons\/([\w-]+)\.png$/;
const ITEM_LIST = "/api/app-bundles/game-servers/current/assets/mcicons/items.json";
const itemIcons = join(root, "resources", "mcicons", "icons");
/** Where it serves the game's own default skins, from the set it vendors. */
const DEFAULT_SKIN =
    /^\/api\/app-bundles\/game-servers\/current\/assets\/default-skins\/(slim|wide)\/([\w-]+)\.png$/;
const defaultSkins = join(root, "resources", "default-skins");
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
const jobsAt = args.indexOf("--jobs");
/** How many quarter seconds of the scene's clock a tour step may take. */
const STEP_TICKS = 120;
/** How long one variant may take before it counts as stuck. */
const VARIANT_LIMIT = 180_000;
/** How many variants are taken at once. */
const jobs = Math.max(
    1,
    Number(jobsAt >= 0 ? args[jobsAt + 1] : Math.min(4, availableParallelism() - 1)) || 1
);

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
        const filmed = CAMERA.exec(path)?.[1];
        const film = filmed ? join(faces, `${filmed}.camera.webp`) : null;
        if (film && existsSync(film)) {
            res.writeHead(200, { "content-type": "image/webp" }).end(readFileSync(film));
            return;
        }
        // The item list the app stages beside those pictures: every vanilla name.
        if (path === ITEM_LIST) {
            const names = readdirSync(itemIcons)
                .filter((name) => name.startsWith("minecraft_") && name.endsWith(".png"))
                .map((name) => name.slice("minecraft_".length, -".png".length))
                .sort();
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(names));
            return;
        }
        // A Minecraft item's picture, from the set the app vendors and stages.
        const item = ITEM_ICON.exec(path)?.[1];
        const icon = item ? join(itemIcons, `${item}.png`) : null;
        if (icon && existsSync(icon)) {
            res.writeHead(200, { "content-type": "image/png" }).end(readFileSync(icon));
            return;
        }
        const worn = DEFAULT_SKIN.exec(path);
        const skin = worn ? join(defaultSkins, worn[1], `${worn[2]}.png`) : null;
        if (skin && existsSync(skin)) {
            res.writeHead(200, { "content-type": "image/png" }).end(readFileSync(skin));
            return;
        }
        const sent = MEDIA_ROUTES.map((route) => route.exec(path)?.[1]).find(Boolean);
        if (sent) {
            const file = [".webp", ".svg"]
                .map((extension) => join(media, `${sent}${extension}`))
                .find((candidate) => existsSync(candidate));
            if (file) {
                res.writeHead(200, { "content-type": TYPES[extname(file)] }).end(
                    readFileSync(file)
                );
                return;
            }
        }
        // A fixture person with a face gets it. Anybody else gets a transparent
        // pixel, as the real route answers for somebody with no picture, and the
        // initials the component drew show through.
        if (path.startsWith("/api/avatar/") || path.startsWith("/api/banner/")) {
            const face = /^\/api\/avatar\/([\w-]+)$/.exec(path)?.[1];
            const file = face ? join(faces, `${face}.webp`) : null;
            if (file && existsSync(file)) {
                res.writeHead(200, { "content-type": "image/webp" }).end(readFileSync(file));
            } else {
                res.writeHead(200, { "content-type": "image/png" }).end(PIXEL);
            }
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

/**
 * Wait for something done inside the page while its frozen clock moves.
 *
 * A hand in a scene waits on the screen it opened, and that screen only draws
 * as the clock moves: awaited with the clock still, it never finishes. The clock
 * runs `first` milliseconds, then a quarter second at a time until `work` is
 * done - or the failure says which `what` never was.
 */
async function ticking(page, work, first, what) {
    let finished = false;
    const settled = work.finally(() => {
        finished = true;
    });
    // Read after a variant that passed its limit is closed under it.
    settled.catch(() => undefined);
    await page.clock.runFor(first);
    for (let ticks = 0; !finished && ticks < STEP_TICKS; ticks++) {
        await page.clock.runFor(250);
        await page.waitForTimeout(20);
    }
    if (!finished) throw new Error(`${what} never finished`);
    await settled;
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

        const variants = [];
        for (const scene of ids)
            for (const [short, locale] of Object.entries(quick ? { en: LOCALES.en } : LOCALES))
                for (const theme of quick ? ["dark"] : THEMES)
                    for (const viewport of quick ? ["desktop"] : Object.keys(VIEWPORTS))
                        variants.push({ scene, short, locale, theme, viewport });

        const shoot = async (
            context,
            problems,
            { scene, short, locale, theme, viewport, file }
        ) => {
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
            await page.goto(`${base}/index.html?scene=${scene.id}&theme=${theme}&locale=${locale}`);
            try {
                await settle(page);
                await ticking(
                    page,
                    page.evaluate(() => window.__scene.prepare()),
                    2000,
                    "prepare"
                );
                await page.waitForTimeout(300);
            } catch (caught) {
                problems.push(`never settled: ${caught.message}`);
            }
            // A Spanish picture with "3d ago" in it is a phrase formatted
            // for the wrong reader, the way a misconfigured page would.
            if (short === "es") {
                const english = await page.evaluate(
                    () => document.body.innerText.match(/\b\d+\s?[smhdw] ago\b/)?.[0]
                );
                if (english) problems.push(`English time in Spanish: "${english}"`);
            }
            const missing = await page.evaluate(() => globalThis.__MISSING__ ?? []);
            for (const what of new Set(missing)) problems.push(`not answered: ${what}`);
            if (problems.length > 0) return;
            const frames = await page.evaluate(() => window.__scene.frames);
            if (frames <= 1 || viewport === "mobile") {
                if (check) return;
                const image = await picture(page, scene, viewport);
                writeFileSync(join(output, file), await image.webp({ quality: 82 }).toBuffer());
                return;
            }
            const shots = [];
            const delays = [];
            for (let index = 0; index < frames; index++) {
                const advance = await page.evaluate((i) => window.__scene.advance(i), index);
                await ticking(
                    page,
                    page.evaluate((i) => window.__scene.step(i), index),
                    advance,
                    `step ${index}`
                );
                await page.clock.runFor(advance);
                await page.waitForTimeout(120);
                if (check) continue;
                shots.push(
                    await (await picture(page, scene, viewport))
                        .resize(VIEWPORTS[viewport].width)
                        .png()
                        .toBuffer()
                );
                delays.push(await page.evaluate((i) => window.__scene.hold(i), index));
            }
            // A step that opened a screen the scene did not answer, or that
            // threw, is the same failure as one at the start.
            const late = await page.evaluate(() => globalThis.__MISSING__ ?? []);
            for (const what of new Set(late)) problems.push(`not answered: ${what}`);
            if (problems.length > 0 || check) return;
            const animated = sharp(shots, { join: { animated: true } }).webp({
                quality: 75,
                delay: delays,
                loop: 0
            });
            writeFileSync(join(output, file), await animated.toBuffer());
        };

        const take = async ({ scene, short, locale, theme, viewport }) => {
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
            const started = Date.now();
            // One variant that never finishes would hold the whole run until the
            // workflow is cancelled, with nothing in the log to say which: each
            // one has a limit, fails by name when it passes it, and reports its
            // time.
            let timer;
            const limit = new Promise((_, fail) => {
                timer = setTimeout(
                    () => fail(new Error(`took longer than ${VARIANT_LIMIT / 1000}s`)),
                    VARIANT_LIMIT
                );
            });
            const shooting = shoot(context, problems, {
                scene,
                short,
                locale,
                theme,
                viewport,
                file
            });
            // What a variant past its limit throws once its context is closed
            // under it is already counted.
            shooting.catch(() => undefined);
            try {
                await Promise.race([shooting, limit]);
            } catch (caught) {
                problems.push(
                    caught.message.startsWith("took longer")
                        ? caught.message
                        : `thrown: ${caught.message}`
                );
            } finally {
                clearTimeout(timer);
                await context.close();
            }
            if (problems.length > 0) failures.push({ name, problems });
            else if (!check) saved++;
            done++;
            process.stdout.write(
                `[readme-media] ${done}/${variants.length} ${name} ${((Date.now() - started) / 1000).toFixed(1)}s
`
            );
        };

        let next = 0;
        let done = 0;
        const worker = async () => {
            while (next < variants.length) await take(variants[next++]);
        };
        await Promise.all(Array.from({ length: Math.min(jobs, variants.length) }, worker));
    } finally {
        await browser.close();
        server.close();
    }
    failures.sort((a, b) => a.name.localeCompare(b.name));
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

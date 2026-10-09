/**
 * The README scenes, checked without a browser.
 *
 * The scene list is bundled with the same rules as the page the pictures are
 * taken of (`bundle.mjs`) and loaded into a DOM-shaped global, so what is checked
 * here is the real definitions and the real fixtures. What only a browser can
 * tell - that every screen draws, asks for nothing unanswered and logs no error -
 * is `capture.mjs --check`, which the media workflow runs before it saves.
 */

import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { bundle } from "../readme-media/bundle.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import {
    LOCALES,
    MEDIA_DIR,
    MOMENT,
    THEMES,
    mediaName,
    variants
} from "../readme-media/variants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = resolve(here, "..", "..");
const repo = resolve(dashboard, "..");
const require = createRequire(join(dashboard, "package.json"));
const { JSDOM } = require("jsdom");

/** Load the scene list the way the page does, but in this process. */
async function loadScenes() {
    const dir = mkdtempSync(join(tmpdir(), "readme-media-"));
    try {
        const out = join(dir, "catalog.mjs");
        await bundle(join(dashboard, "scripts", "readme-media", "runtime", "catalog.tsx"), out);
        const dom = new JSDOM("<!doctype html><html><body></body></html>", {
            url: "http://localhost/"
        });
        for (const key of [
            "window",
            "document",
            "location",
            "navigator",
            "localStorage",
            "sessionStorage"
        ]) {
            Object.defineProperty(globalThis, key, {
                value: dom.window[key],
                configurable: true,
                writable: true
            });
        }
        for (const key of [
            "HTMLElement",
            "Element",
            "Node",
            "MutationObserver",
            "getComputedStyle",
            "matchMedia"
        ]) {
            if (!(key in globalThis)) globalThis[key] = dom.window[key];
        }
        // What the bundle reads `process.env` as, the way the page defines it.
        globalThis.__READMEMEDIA_ENV__ = {};
        return (await import(pathToFileURL(out).href)).SCENES;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const SCENES = await loadScenes();

/** Every context a scene is drawn in: each language and each theme. */
const CONTEXTS = Object.values(LOCALES).flatMap((locale) =>
    THEMES.map((theme) => ({
        locale,
        theme,
        now: MOMENT,
        say: (en, es) => (locale === "es-ES" ? es : en)
    }))
);

/** A route's `:params` filled in, so a fixture that reads its URL gets one. */
function sampleUrl(pattern) {
    const path = pattern.replace(/:[A-Za-z]+/g, "fixture");
    return new URL(path.startsWith("http") ? path : `http://localhost${path}`);
}

test("every scene has an id the image files can be named after, once", () => {
    const ids = SCENES.map((scene) => scene.id);
    assert.ok(ids.length > 0);
    assert.deepEqual([...new Set(ids)], ids, "an id is used twice");
    for (const id of ids)
        assert.match(id, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, `${id} is not a file-safe name`);
});

test("covers every screen the README promises", () => {
    const ids = new Set(SCENES.map((scene) => scene.id));
    for (const id of [
        "chat",
        "call",
        "in-call",
        "tasks",
        "task-panel",
        "deploy",
        "deploy-logs",
        "drive",
        "mail",
        "calendar",
        "games",
        "office",
        "vault",
        "marketplace",
        "launcher",
        "settings"
    ]) {
        assert.ok(ids.has(id), `no ${id} scene`);
    }
});

test("each scene is drawn at the route its screen lives at", () => {
    for (const scene of SCENES) {
        assert.match(scene.path, /^\/[^\s]*$/, `${scene.id}: ${scene.path}`);
        for (const [name, value] of Object.entries(scene.params ?? {})) {
            assert.ok(
                scene.path.includes(value),
                `${scene.id}: param ${name} is not in ${scene.path}`
            );
        }
    }
});

test("every action, route and stream answers in every language and theme", async () => {
    for (const scene of SCENES) {
        for (const ctx of CONTEXTS) {
            const where = `${scene.id} (${ctx.locale}, ${ctx.theme})`;
            for (const [name, answer] of Object.entries(scene.actions?.(ctx) ?? {})) {
                assert.equal(typeof answer, "function", `${where}: action ${name}`);
                assert.notEqual(
                    await answer(),
                    undefined,
                    `${where}: action ${name} answers nothing`
                );
            }
            for (const [route, answer] of Object.entries(scene.api?.(ctx) ?? {})) {
                assert.match(
                    route,
                    /^(GET|POST|PUT|PATCH|DELETE) (\/api\/|https:\/\/)/,
                    `${where}: route ${route}`
                );
                const [method, pattern] = route.split(" ");
                const body = await answer({ url: sampleUrl(pattern), method, body: null });
                assert.notEqual(body, undefined, `${where}: ${route} answers nothing`);
            }
            for (const [path, events] of Object.entries(scene.streams?.(ctx) ?? {})) {
                assert.match(path, /^\/api\//, `${where}: stream ${path}`);
                assert.ok(events.length > 0, `${where}: stream ${path} says nothing`);
                for (const event of events)
                    assert.equal(typeof event.type, "string", `${where}: ${path}`);
            }
        }
    }
});

test("an animation has frames, and each is held long enough to be seen", () => {
    for (const scene of SCENES.filter((one) => one.animation)) {
        const { frames, hold, advance } = scene.animation;
        assert.ok(Number.isInteger(frames) && frames > 1, `${scene.id}: ${frames} frames`);
        for (let index = 0; index < frames; index++) {
            assert.ok(hold(index) >= 200, `${scene.id}: frame ${index} is held ${hold(index)}ms`);
            if (advance)
                assert.ok(advance(index) >= 0, `${scene.id}: frame ${index} goes back in time`);
        }
    }
});

test("fixture data names nobody real: reserved names (RFC 2606) and networks only", async () => {
    const allowedHost = (host) =>
        /(^|\.)example(\.(com|net|org))?$|\.(test|invalid)$/.test(host) ||
        host === "localhost" ||
        host.endsWith(".local") ||
        /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.0\.2\.|^198\.51\.100\.|^203\.0\.113\./.test(
            host
        );
    for (const scene of SCENES) {
        const ctx = CONTEXTS[0];
        const answers = [];
        for (const answer of Object.values(scene.actions?.(ctx) ?? {}))
            answers.push(await answer());
        for (const [route, answer] of Object.entries(scene.api?.(ctx) ?? {})) {
            const [method, pattern] = route.split(" ");
            const body = await answer({ url: sampleUrl(pattern), method, body: null });
            if (!(body instanceof Response)) answers.push(body);
        }
        answers.push(scene.streams?.(ctx) ?? {});
        const text = JSON.stringify(answers);
        for (const [, domain] of text.matchAll(
            /\b[A-Za-z][\w.+-]*@((?:[\w-]+\.)+[A-Za-z]{2,})\b/g
        )) {
            assert.ok(allowedHost(domain), `${scene.id}: an address at ${domain}`);
        }
        for (const [, host] of text.matchAll(/\b(?:https?|postgres):\/\/([^/:"\s\\]+)/g)) {
            // An update compares commits on GitHub; the repository it names is a fixture one.
            if (host === "github.com") continue;
            assert.ok(allowedHost(host), `${scene.id}: a link to ${host}`);
        }
    }
});

test("every picture the scenes promise is committed, and nothing else is", () => {
    const dir = join(repo, MEDIA_DIR);
    const expected = new Set(
        SCENES.flatMap((scene) =>
            variants().map((v) => mediaName(scene.id, v.theme, v.language, v.viewport))
        )
    );
    const present = new Set(readdirSync(dir).filter((file) => file.endsWith(".webp")));
    for (const file of expected)
        assert.ok(present.has(file), `${file} is missing - run the media workflow`);
    for (const file of present) assert.ok(expected.has(file), `${file} belongs to no scene`);
});

test("both READMEs show every scene, from files that exist", () => {
    for (const [readme, language] of [
        ["README.md", "en"],
        ["README.es.md", "es"]
    ]) {
        const text = readFileSync(join(repo, readme), "utf8");
        const linked = [...text.matchAll(new RegExp(`${MEDIA_DIR}/([\\w-]+\\.webp)`, "g"))].map(
            (match) => match[1]
        );
        for (const file of linked)
            assert.ok(existsSync(join(repo, MEDIA_DIR, file)), `${readme} links ${file}`);
        for (const scene of SCENES) {
            assert.ok(
                linked.includes(mediaName(scene.id, "dark", language, "desktop")),
                `${readme} does not show ${scene.id}`
            );
        }
    }
});

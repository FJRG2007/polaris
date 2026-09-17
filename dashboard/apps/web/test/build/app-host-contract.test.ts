/**
 * What the dashboard offers installable apps, checked where a mistake is silent.
 *
 * A server service is loaded on first use, which turns whatever it returns into a
 * promise. For a function that already returned one, nothing changes. For one
 * that did not, an app that used to write `${safeName(id)}` now writes
 * `[object Promise]` into a path, and nothing in the type system objects to a
 * promise inside a template string. So every service offered that way has to be
 * one that is already asynchronous in its own module.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const SRC = resolve(__dirname, "../../src");
const HOST = readFileSync(join(SRC, "lib/app-host/server.ts"), "utf8");

/** Each area loaded on first use, and the module it loads. */
const loads = new Map(
    [...HOST.matchAll(/^\s{4}(\w+): once\(\(\) => import\("@\/([^"]+)"\)\),$/gm)].map((match) => [
        match[1] ?? "",
        match[2] ?? ""
    ])
);

/** Every service offered from one of those areas. */
const lazy = [...HOST.matchAll(/^\s{8}(\w+): later\(load\.(\w+), "(\w+)"\),$/gm)].map((match) => ({
    name: match[3] ?? "",
    area: match[2] ?? ""
}));

/** Every service the host offers at all, however it is provided. */
const offered = (() => {
    const body = /^export const serverHost = \{$([\s\S]*?)^\};$/m.exec(HOST)?.[1] ?? "";
    const found: { area: string; name: string; from: string }[] = [];
    let area = "";
    for (const line of body.split("\n")) {
        const opens = /^\s{4}(\w+): \{$/.exec(line);
        if (opens) area = opens[1] ?? "";
        const entry = /^\s{8}(\w+): (.+?),?$/.exec(line);
        if (entry) found.push({ area, name: entry[1] ?? "", from: entry[2] ?? "" });
    }
    return found;
})();

/**
 * Offered as it is rather than loaded on first use, and why that is allowed.
 *
 * `appsCatalog` is a list and a lookup into it - code, no database, no session,
 * nothing a test replaces - and both are read while an app's module is being
 * evaluated, which a promise cannot be. Everything else loads on first use.
 */
const EAGER = ["appsCatalog.POLARIS_APP_CATALOG", "appsCatalog.findApp"];

function sourceOf(module: string): string {
    for (const candidate of [`${module}.ts`, `${module}.tsx`]) {
        const path = join(SRC, candidate);
        if (existsSync(path)) return readFileSync(path, "utf8");
    }
    throw new Error(`no module ${module}`);
}

describe("the services the dashboard offers apps", () => {
    it("are found at all, so this cannot pass by reading nothing", () => {
        expect(loads.size).toBeGreaterThan(5);
        expect(lazy.length).toBeGreaterThan(10);
        expect(offered.length).toBeGreaterThanOrEqual(lazy.length);
    });

    // Otherwise a service added any other way than `later(...)` is offered
    // without ever being read here, and the check below never sees it.
    it.each(offered)("$area $name is loaded on first use or named as an exception", (service) => {
        const lazily = /^later\(load\.\w+, "\w+"\)$/.test(service.from);
        const where = `${service.area}.${service.name}`;
        expect(lazily || EAGER.includes(where), where).toBe(true);
    });

    it("names no exception the host no longer offers", () => {
        const where = offered.map((service) => `${service.area}.${service.name}`);
        expect(EAGER.filter((name) => !where.includes(name))).toEqual([]);
    });

    it.each(lazy)("$area.$name is asynchronous where it is defined", ({ name, area }) => {
        const module = loads.get(area);
        expect(module, `area ${area} is not loaded anywhere`).toBeTruthy();
        const source = sourceOf(module as string);
        const asyncFunction = new RegExp(`^export\\s+async\\s+function\\s+${name}\\b`, "m");
        const returnsPromise = new RegExp(
            `^export\\s+function\\s+${name}\\b[\\s\\S]*?\\)\\s*:\\s*Promise<`,
            "m"
        );
        const asyncArrow = new RegExp(`^export\\s+const\\s+${name}\\s*=\\s*async\\b`, "m");
        const declaration = new RegExp(`^export\\s+function\\s+${name}\\b[^{]*`, "m").exec(source)?.[0] ?? "";
        const ok =
            asyncFunction.test(source) ||
            asyncArrow.test(source) ||
            (returnsPromise.test(source) && /\)\s*:\s*Promise</.test(declaration));
        // A synchronous service either moves to a package (as LOCAL_TARGET and the
        // zoom arithmetic did) or its callers await it and it is listed here.
        expect(ok || AWAITED.includes(name), `${area}.${name}`).toBe(true);
    });

    it.each(AWAITED)("%s is awaited wherever an app calls it", (name) => {
        const careless: string[] = [];
        for (const file of appFiles()) {
            const text = readFileSync(file, "utf8");
            for (const match of text.matchAll(new RegExp(`(\\w*\\s*)\\b${name}\\(`, "g"))) {
                if (!/^(await|void)\s+$/.test(match[1] ?? "")) careless.push(`${file}: ${match[0]}`);
                // What it used to be could not fail, so a call nobody waits for
                // was safe to leave alone. It is a promise now, and one nobody
                // has taken the rejection of is the whole process on its next
                // tick, long after the request that started it has answered.
                if (/^void\s+$/.test(match[1] ?? "") && !caught(text, (match.index ?? 0) + match[0].length))
                    careless.push(`${file}: void ${name}(...) with nothing to catch it`);
            }
        }
        expect(careless).toEqual([]);
    });
});

/** Synchronous in the dashboard, so asynchronous for an app: every call awaits it. */
const AWAITED = ["hostPortForApp", "publishChatChange", "safeName", "serviceRef"];

/** Where the arguments that open at `from` are closed. */
function past(text: string, from: number): number {
    let depth = 1;
    let at = from;
    while (at < text.length && depth > 0) {
        if (text[at] === "(") depth += 1;
        if (text[at] === ")") depth -= 1;
        at += 1;
    }
    return at;
}

/** Whether a `.catch` is anywhere in what is chained onto the call whose
 *  arguments open at `from` - straight after it, or past a `.then`. */
function caught(text: string, from: number): boolean {
    let at = past(text, from);
    for (;;) {
        const next = /^\s*\.(catch|then|finally)\(/.exec(text.slice(at));
        if (!next) return false;
        if (next[1] === "catch") return true;
        at = past(text, at + next[0].length);
    }
}

function appFiles(): string[] {
    const apps = resolve(__dirname, "../../..");
    const found: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
            const full = join(directory, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
        }
    };
    for (const app of readdirSync(apps)) {
        const src = join(apps, app, "src");
        if (app !== "web" && existsSync(join(apps, app, "package.json")) && existsSync(src)) walk(src);
    }
    return found;
}

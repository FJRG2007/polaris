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
            }
        }
        expect(careless).toEqual([]);
    });
});

/** Synchronous in the dashboard, so asynchronous for an app: every call awaits it. */
const AWAITED = ["hostPortForApp", "publishChatChange", "safeName", "serviceRef"];

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

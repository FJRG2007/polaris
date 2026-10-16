/**
 * Every namespace a client screen translates with reaches the browser.
 *
 * `useTranslations("ns")` in a client component reads only what a `<Messages
 * namespaces={[...]}>` above it handed down; a namespace nobody handed down is
 * not an error anywhere, it is the key itself printed on the screen. That is how
 * Agent rollouts and the Deploy registries shipped reading
 * "agentRollouts.rollout.heading": the catalogs had every string, and no route
 * gave them to the page.
 *
 * So for each client file under `src/app`, the namespaces it uses must be
 * provided by the root layout, the app shell, or a `<Messages>` in a file on its
 * route - an ancestor directory, or below it, for a component a nested page
 * renders from its parent's folder.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const WEB = resolve(__dirname, "../..");
const APP = join(WEB, "src", "app");

/** What the root layout and the app shell (`components/app-chrome.tsx`) give
 *  every screen. */
const ROOT = ["common", "components"];
const SHELL = ["nav", "chat", "shortcuts", "tours"];

/** Files rendered from a route other than the one their folder is on. Each says
 *  where, so the exception can be checked. */
const RENDERED_ELSEWHERE: Record<string, string> = {
    // Drawn by account/preferences, which provides "account".
    "src/app/(app)/chat/spoilers-card.tsx": "account/preferences"
};

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return files(path);
        return /\.tsx?$/.test(entry) ? [path] : [];
    });
}

function provided(source: string): string[] {
    return [...source.matchAll(/namespaces=\{\[([^\]]*)\]\}/g)].flatMap((match) =>
        [...match[1]!.matchAll(/"([^"]+)"/g)].map((name) => name[1]!)
    );
}

describe("client translation namespaces", () => {
    it("are handed down on every route that uses them", () => {
        const all = files(APP);
        const providers = all
            .map((path) => ({ dir: dirname(path), names: provided(readFileSync(path, "utf8")) }))
            .filter((entry) => entry.names.length > 0);

        const missing = all.flatMap((path) => {
            const name = relative(WEB, path).split(sep).join("/");
            if (name in RENDERED_ELSEWHERE) return [];
            const used = new Set(
                [...readFileSync(path, "utf8").matchAll(/useTranslations\(\s*"([^"]+)"/g)].map(
                    (match) => match[1]!.split(".")[0]!
                )
            );
            if (used.size === 0) return [];
            const dir = dirname(path);
            const have = new Set([...ROOT, ...(name.includes("/(app)/") ? SHELL : [])]);
            for (const entry of providers) {
                const onRoute = dir === entry.dir || dir.startsWith(entry.dir + sep) || entry.dir.startsWith(dir + sep);
                if (onRoute) entry.names.forEach((namespace) => have.add(namespace));
            }
            return [...used].filter((namespace) => !have.has(namespace)).map((namespace) => `${name}: ${namespace}`);
        });

        expect(missing).toEqual([]);
    });
});

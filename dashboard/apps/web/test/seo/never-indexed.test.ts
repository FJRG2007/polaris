/**
 * Nothing Polaris serves can end up in a search engine.
 *
 * Every route file under `src/app` - page or handler, public or behind a
 * sign-in - is turned into an address and run through the same matcher Next
 * uses for `headers()`, and each must come back `X-Robots-Tag: noindex`. So a
 * new public page, a new download route or a new top-level folder cannot ship
 * without it: the rule is checked against the routes that exist, not against a
 * list somebody remembered to update.
 *
 * Every top-level public folder is also either a token path (no Referer leaves
 * it) or named below with the reason it is not; and robots.txt keeps no page
 * away from crawlers, because a crawler that may not fetch a page never reads
 * its noindex.
 */

import robots from "../../src/app/robots";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { pathToRegexp } from "next/dist/compiled/path-to-regexp";
import nextConfig, { TOKEN_PATH_PREFIXES } from "../../next.config.mjs";

const APP = join(process.cwd(), "src/app");

/** Top-level public folders whose address is a name, not a credential. */
const NOT_TOKEN_PATHS = new Map<string, string>([
    [".well-known", "discovery documents other software reads, public by design"],
    ["api", "the API: answers JSON and files, each route checks its own caller"],
    ["cli", "the CLI's own downloads, the same file for everybody"],
    ["edge", "the edge's sign-in check, called by Traefik rather than a browser"],
    ["o", "an organization's public page, by its public slug"],
    ["oauth", "sign-in screens"],
    ["status", "a public status page, by its public slug"],
    ["u", "a public profile, by its username"],
    ["wall", "a wall panel for somebody signed in, by its id; the lent link is /k/"]
]);

async function headersFor(path: string): Promise<Record<string, string>> {
    const rules = (await nextConfig.headers?.()) ?? [];
    const out: Record<string, string> = {};
    for (const rule of rules) {
        const matcher = pathToRegexp(rule.source, [], {
            strict: true,
            sensitive: false,
            delimiter: "/"
        });
        if (!matcher.test(path)) continue;
        for (const header of rule.headers) out[header.key] = header.value;
    }
    return out;
}

/** Every page and route handler, as the address it answers. */
function routeAddresses(directory: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
            out.push(...routeAddresses(full));
            continue;
        }
        if (!/^(page|route)\.tsx?$/.test(entry)) continue;
        const segments = relative(APP, directory)
            .split(/[\\/]/)
            .filter((segment) => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith("@"))
            .map((segment) => (segment.startsWith("[") ? "sample-token" : segment));
        out.push(`/${segments.join("/")}`);
    }
    return out;
}

/** Every layout and page, the files whose metadata reaches the document. */
function metadataFiles(directory: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) out.push(...metadataFiles(full));
        else if (/^(layout|page)\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
}

describe("search engines", () => {
    const addresses = routeAddresses(APP);

    it("finds the routes it is checking", () => {
        expect(addresses).toContain("/c/sample-token");
        expect(addresses).toContain("/c/sample-token/files/sample-token");
        expect(addresses.length).toBeGreaterThan(100);
    });

    it("are told noindex on every page, file and API answer", async () => {
        const missing: string[] = [];
        for (const address of addresses) {
            const robotsTag = (await headersFor(address))["X-Robots-Tag"] ?? "";
            if (
                !/noindex/.test(robotsTag) ||
                !/nofollow/.test(robotsTag) ||
                !/noarchive/.test(robotsTag)
            )
                missing.push(address);
        }
        expect(missing).toEqual([]);
    });

    it("are told noindex by the root layout's metadata too", () => {
        const layout = readFileSync(join(APP, "layout.tsx"), "utf8");
        expect(layout).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false/);
    });

    it("may fetch every page, so the noindex is read, and get no sitemap", () => {
        const file = robots();
        const rules = Array.isArray(file.rules) ? file.rules : [file.rules];
        expect(rules.flatMap((rule) => rule.disallow ?? [])).toEqual([]);
        expect(file.sitemap).toBeUndefined();
    });
});

describe("links out of a public page", () => {
    it("never carry a token path to another site", async () => {
        for (const prefix of TOKEN_PATH_PREFIXES) {
            const headers = await headersFor(`/${prefix}/sample-token`);
            expect(headers["Referrer-Policy"], prefix).toBe("no-referrer");
        }
        expect((await headersFor("/home"))["Referrer-Policy"]).toBe(
            "strict-origin-when-cross-origin"
        );
    });

    it("leave the referrer to the header, which a page's meta referrer would override", () => {
        const offenders = metadataFiles(APP).filter((file) =>
            /\breferrer\s*:/.test(readFileSync(file, "utf8"))
        );
        expect(offenders).toEqual([]);
    });

    it("every top-level public folder is a token path or says why not", () => {
        const folders = readdirSync(APP).filter(
            (entry) => statSync(join(APP, entry)).isDirectory() && !/^\(.*\)$/.test(entry)
        );
        const unexplained = folders.filter(
            (folder) => !TOKEN_PATH_PREFIXES.includes(folder) && !NOT_TOKEN_PATHS.has(folder)
        );
        expect(unexplained).toEqual([]);
    });
});

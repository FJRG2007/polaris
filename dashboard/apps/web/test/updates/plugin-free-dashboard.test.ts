/**
 * No device plugin's words or code live in the dashboard.
 *
 * A plugin installs and updates on its own, from the desktop app. The moment one
 * of its sentences, names or codes is written into the dashboard's sources or
 * messages, a release of that plugin has to change the dashboard too - which
 * publishes a new web image and offers every deployment a Polaris update for a
 * change to a plugin it may not even have. A plugin's own words go in its
 * manifest (`statusTexts`, its settings' labels) instead, and the page renders
 * them from there.
 *
 * The names checked are read from every plugin under clients/device-plugins, so a
 * new plugin is covered the day it lands.
 */

import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";

const REPO = join(__dirname, "..", "..", "..", "..", "..");
const PLUGINS = join(REPO, "clients", "device-plugins");
/** What the web image is built from, as far as words and code go. */
const SCANNED = ["dashboard/apps/web/src", "dashboard/apps/web/messages", "dashboard/packages"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".next", "test", "tests", "__tests__", ".turbo", "generated", "wasm", "wasm-mls", "native"]);
const SCANNED_FILES = /\.(ts|tsx|js|mjs|cjs|json|css)$/;

interface Manifest {
    id: string;
    name: string;
    claims?: { name: string }[];
    statusTexts?: Record<string, unknown>;
}

/** The words that name one plugin: its id and its parts, its name with and without the maker, its devices, its status codes. */
function pluginTerms(manifest: Manifest): string[] {
    const words = manifest.name.split(/\s+/);
    const terms = [
        manifest.id,
        ...manifest.id.split("-").filter((part) => part.length >= 5),
        manifest.name,
        ...(words.length > 1 ? [words.slice(1).join(" ")] : []),
        ...(manifest.claims ?? []).map((claim) => claim.name),
        ...Object.keys(manifest.statusTexts ?? {})
    ];
    return [...new Set(terms.map((term) => term.toLowerCase()))];
}

function manifests(): Manifest[] {
    return readdirSync(PLUGINS)
        .map((name) => join(PLUGINS, name, "manifest.json"))
        .filter((path) => {
            try {
                return statSync(path).isFile();
            } catch {
                return false;
            }
        })
        .map((path) => JSON.parse(readFileSync(path, "utf8")) as Manifest);
}

function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) out.push(...filesUnder(join(dir, entry.name)));
        } else if (entry.isFile() && SCANNED_FILES.test(entry.name)) out.push(join(dir, entry.name));
    }
    return out;
}

describe("the dashboard names no device plugin", () => {
    const plugins = manifests();

    it("finds the plugins it guards against", () => {
        expect(plugins.length).toBeGreaterThan(0);
        for (const manifest of plugins) expect(pluginTerms(manifest).length).toBeGreaterThan(1);
    });

    it("keeps every plugin's names, words and codes out of the dashboard's sources and messages", () => {
        const terms = plugins.flatMap((manifest) => pluginTerms(manifest).map((term) => ({ id: manifest.id, term })));
        const found: string[] = [];
        for (const root of SCANNED) {
            for (const file of filesUnder(join(REPO, root))) {
                const lines = readFileSync(file, "utf8").split("\n");
                lines.forEach((line, index) => {
                    const lower = line.toLowerCase();
                    for (const { id, term } of terms) if (lower.includes(term)) found.push(`${relative(REPO, file).split("\\").join("/")}:${index + 1} names ${id} ("${term}")`);
                });
            }
        }
        expect(found).toEqual([]);
    });
});

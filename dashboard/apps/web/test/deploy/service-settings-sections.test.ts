/**
 * Every setting of a service's Settings tab is in exactly one section: each
 * entry of `service-settings-index.ts` is drawn by one card and only one, and no
 * card of the tab is drawn without an entry - so regrouping the tab cannot lose a
 * setting, list it twice, or leave one the filter cannot find.
 *
 * Read from the sources the tab is built from, since most cards load their data
 * from server actions there is no host here to answer.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    SERVICE_SETTINGS_INDEX,
    SERVICE_SETTINGS_SECTIONS
} from "@/app/(app)/apps/deploy/service-settings-index";

const DEPLOY = resolve(__dirname, "../../src/app/(app)/apps/deploy");

/** The files whose cards the Settings tab draws. */
const FILES = [
    "service-settings.tsx",
    "service-source-cards.tsx",
    "edge-settings.tsx",
    "deploy-behaviour-section.tsx",
    "scaling-section.tsx",
    "build-machine-section.tsx",
    "upload-source.tsx",
    "private-network-panel.tsx",
    "gpu-card.tsx",
    "deploy-hooks-card.tsx",
    "registries/registry-pick-card.tsx"
];

/** Each `<SettingsCard ...>` opening tag in a file, as text. */
function cardTags(source: string): string[] {
    return [...source.matchAll(/<SettingsCard\b[\s\S]*?(?:\btitle=)/g)].map((match) => match[0]);
}

const tags = FILES.flatMap((file) =>
    cardTags(readFileSync(join(DEPLOY, file), "utf8")).map((tag) => ({ file, tag }))
);
const entryOf = (tag: string) => /\bentry="([^"]+)"/.exec(tag)?.[1] ?? null;

describe("the sections of a service's Settings tab", () => {
    it("give every card an entry in the index", () => {
        const missing = tags.filter(({ tag }) => entryOf(tag) === null).map(({ file }) => file);
        expect(missing).toEqual([]);
        const unknown = tags
            .map(({ tag }) => entryOf(tag))
            .filter((entry) => entry !== null && !(entry in SERVICE_SETTINGS_INDEX));
        expect(unknown).toEqual([]);
    });

    it("draw every entry of the index from exactly one file", () => {
        for (const entry of Object.keys(SERVICE_SETTINGS_INDEX)) {
            const files = new Set(tags.filter(({ tag }) => entryOf(tag) === entry).map(({ file }) => file));
            expect([entry, files.size]).toEqual([entry, 1]);
        }
    });

    it("draw one card per entry, apart from a card's own alternatives", () => {
        const counts = new Map<string, number>();
        for (const { tag } of tags) {
            const entry = entryOf(tag);
            if (entry) counts.set(entry, (counts.get(entry) ?? 0) + 1);
        }
        // The Source card is one card with a shape per kind of source.
        const repeated = [...counts].filter(([entry, count]) => count > 1 && entry !== "repository");
        expect(repeated).toEqual([]);
    });

    it("put each entry in a section the tab draws, security in Security & edge", () => {
        for (const entry of Object.values(SERVICE_SETTINGS_INDEX)) {
            expect(SERVICE_SETTINGS_SECTIONS).toContain(entry.section);
        }
        const security = Object.entries(SERVICE_SETTINGS_INDEX)
            .filter(([, entry]) => entry.section === "security")
            .map(([id]) => id);
        expect(security).toEqual(
            expect.arrayContaining(["securityHeaders", "traffic", "publishPort", "blockVulnerable"])
        );
        expect(SERVICE_SETTINGS_INDEX.repository.section).toBe("source");
        expect(SERVICE_SETTINGS_INDEX.builder.section).toBe("build");
    });

    it("leave no section without a setting, in Railway's order", () => {
        expect(SERVICE_SETTINGS_SECTIONS).toEqual([
            "source",
            "networking",
            "security",
            "scale",
            "build",
            "deploy",
            "other",
            "danger"
        ]);
        const used = new Set(Object.values(SERVICE_SETTINGS_INDEX).map((entry) => entry.section));
        expect(SERVICE_SETTINGS_SECTIONS.filter((section) => !used.has(section))).toEqual([]);
    });
});

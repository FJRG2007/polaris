/**
 * No message with a tag in it reaches a screen with the tag printed as text.
 *
 * `Last active <time></time>` was on an administrator's list of somebody's
 * sessions, word for word: the message was formatted through `t.rich` with the
 * time handed over as an element rather than as a function, the formatter
 * refused it, and the translator answered with the raw message. Plain `t()` on a
 * tagged message fails the same way. Neither is visible at build time, so every
 * call site in every app is held to it here.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTranslator, type Catalog } from "@polaris/core";
import { indexCatalog, indexCatalogFolder, scanFolder, scanSource, type TagIndex } from "./tagged-calls";

const APPS = resolve(__dirname, "../../..");
const web = indexCatalogFolder(join(APPS, "web", "messages", "en-US"));

const INDEX: TagIndex = new Map([
    [
        "components",
        new Map<string, readonly string[]>([
            ["sessionsTable.lastActiveAt", ["time"]],
            ["sessionsTable.lastActive", []]
        ])
    ],
    ["admin", new Map<string, readonly string[]>([["title", []]])]
]);

const problems = (source: string) => scanSource("screen.tsx", source, INDEX).map((finding) => finding.problem);

describe("the tagged-call scan", () => {
    it("finds a tagged message given an element instead of a function", () => {
        expect(
            problems(`
                const t = useTranslations("components");
                t.rich("sessionsTable.lastActiveAt", { time: <RelativeTime iso={at} /> });`)
        ).toEqual(["<time> is given a value instead of a function"]);
    });

    it("finds a tagged message formatted with plain t()", () => {
        expect(
            problems(`
                const t = useTranslations("components");
                t("sessionsTable.lastActiveAt");`)
        ).toEqual(["has tags (time) but is formatted with plain t()"]);
    });

    it("finds a tag nobody fills", () => {
        expect(
            problems(`
                const t = useTranslations("components");
                t.rich("sessionsTable.lastActiveAt", { other: () => null });`)
        ).toEqual(["<time> is given nothing"]);
    });

    it("sees through a constant holding the element", () => {
        expect(
            problems(`
                const t = useTranslations("components");
                const time = <RelativeTime iso={at} />;
                t.rich("sessionsTable.lastActiveAt", { time });`)
        ).toEqual(["<time> is given a value instead of a function"]);
    });

    it("blames a template key only when every key it can reach is tagged", () => {
        expect(
            problems(`
                const t = useTranslations("components");
                t(\`sessionsTable.\${which}\`);`)
        ).toEqual([]);
    });

    it("takes a bare word on an unknown function for a field name, not a key", () => {
        expect(problems(`str("lastActiveAt"); format("sessionsTable.lastActiveAt");`)).toEqual([
            "has tags (time) but is formatted with plain t()"
        ]);
    });

    it("follows a translator handed in as a typed parameter", () => {
        expect(
            problems(`
                function line(t: NamespaceTranslator<"components">) { return t("sessionsTable.lastActiveAt"); }`)
        ).toHaveLength(1);
    });

    it("accepts a function, and leaves untagged messages and other namespaces alone", () => {
        expect(
            problems(`
                const t = useTranslations("components");
                const a = useTranslations("admin");
                t.rich("sessionsTable.lastActiveAt", { time: () => <RelativeTime iso={at} /> });
                t.rich("sessionsTable.lastActiveAt", { time: renderTime });
                t("sessionsTable.lastActive");
                a("sessionsTable.lastActiveAt");`)
        ).toEqual([]);
    });

    it("finds the real call sites, so this cannot pass by reading nothing", () => {
        const tagged = [...web.values()].flatMap((keys) => [...keys.values()]).filter((tags) => tags.length > 0);
        expect(tagged.length).toBeGreaterThan(50);
    });
});

describe("the formatter this guards", () => {
    // What the reader saw: the failure the scan exists to keep off a screen.
    it("prints the raw message when a tag is given an element, and the time when given a function", () => {
        const t = createTranslator("en-US", { at: "Last active <time></time>" }, { onProblem: () => {} });
        expect(t.rich("at", { time: "3 minutes ago" })).toEqual(["Last active <time></time>"]);
        expect(t.rich("at", { time: () => "3 minutes ago" }).join("")).toBe("Last active 3 minutes ago");
    });
});

describe("every tagged message in every app", () => {
    const roots: { name: string; source: string; index: TagIndex }[] = [
        { name: "web", source: join(APPS, "web", "src"), index: web },
        ...["calendar", "game-servers", "places"].map((app) => ({
            name: app,
            source: join(APPS, app, "src"),
            // An app reads its own catalogs, and the host's through the host.
            index: indexCatalogFolder(join(APPS, app, "messages", "en-US"), new Map(web))
        })),
        {
            name: "extension",
            source: join(APPS, "extension", "src"),
            index: new Map([
                [
                    "extension",
                    indexCatalog(
                        JSON.parse(readFileSync(join(APPS, "extension", "src", "messages", "en-US.json"), "utf8")) as Catalog
                    )
                ]
            ])
        }
    ];

    it.each(roots)("is formatted so its tags render, in $name", ({ source, index }) => {
        const findings = scanFolder(source, index, APPS).map(
            (finding) => `${finding.file}:${finding.line} ${finding.namespace}.${finding.key}: ${finding.problem}`
        );
        expect(findings).toEqual([]);
    });
});

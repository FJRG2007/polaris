/**
 * Every key a screen translates is in its catalog.
 *
 * A key the catalog does not hold is drawn as the key itself - the connections
 * hub showed `tasks.trackers.connect` and `tasks.trackers.emptyTitle` - and no
 * build step notices. So every literal key read through a translator bound to a
 * namespace is looked up here, in the dashboard and in every app with catalogs.
 */

import { join, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Catalog } from "@polaris/core";
import {
    indexCatalog,
    indexCatalogFolder,
    missingKeys,
    missingKeysInFolder,
    type TagIndex
} from "./tagged-calls";

const APPS = resolve(__dirname, "../../..");
const web = indexCatalogFolder(join(APPS, "web", "messages", "en-US"));

const INDEX: TagIndex = new Map([
    ["tasks", new Map<string, readonly string[]>([["trackers.title", []]])],
    ["common", new Map<string, readonly string[]>([["save", []]])]
]);

const keys = (source: string) =>
    missingKeys("screen.tsx", source, INDEX).map(
        (finding) => `${finding.namespace}.${finding.key}`
    );

describe("the missing-key scan", () => {
    it("finds a key its namespace does not hold", () => {
        expect(
            keys(`
                const t = useTranslations("tasks");
                t("trackers.title");
                t("trackers.connect");`)
        ).toEqual(["tasks.trackers.connect"]);
    });

    it("blames a translator bound twice only when neither namespace holds the key", () => {
        expect(
            keys(`
                function A() { const t = useTranslations("tasks"); return t("trackers.title"); }
                function B() { const t = useTranslations("common"); return t("save") + t("gone"); }`)
        ).toEqual(["tasks|common.gone"]);
    });

    it("leaves alone a translator it cannot place and a key built at run time", () => {
        expect(
            keys(`
                const t = useTranslations(namespace);
                t("anything");
                const u = useTranslations("tasks");
                u(\`trackers.\${which}\`);`)
        ).toEqual([]);
    });
});

describe("every translated key in every app", () => {
    const apps = readdirSync(APPS).filter((app) =>
        existsSync(join(APPS, app, "messages", "en-US"))
    );
    const roots: { name: string; source: string; index: TagIndex }[] = [
        ...apps.map((app) => ({
            name: app,
            source: join(APPS, app, "src"),
            // An app reads its own catalogs, and the host's through the host.
            index:
                app === "web"
                    ? web
                    : indexCatalogFolder(join(APPS, app, "messages", "en-US"), new Map(web))
        })),
        {
            name: "extension",
            source: join(APPS, "extension", "src"),
            index: new Map([
                [
                    "extension",
                    indexCatalog(
                        JSON.parse(
                            readFileSync(
                                join(APPS, "extension", "src", "messages", "en-US.json"),
                                "utf8"
                            )
                        ) as Catalog
                    )
                ]
            ])
        }
    ];

    it.each(roots)("is in a catalog, in $name", ({ source, index }) => {
        const findings = missingKeysInFolder(source, index, APPS).map(
            (finding) => `${finding.file}:${finding.line} ${finding.namespace}.${finding.key}`
        );
        expect(findings).toEqual([]);
    });
});

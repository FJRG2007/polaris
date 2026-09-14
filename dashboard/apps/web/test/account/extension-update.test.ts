/**
 * How the extension finds out it is out of date.
 *
 * An extension loaded by hand never updates itself, and nothing anywhere would
 * ever say so - which is the whole reason this exists. What is pinned here is
 * where it asks, because that decision is a permission decision.
 *
 * The extension's manifest declares no host permission at all: the single origin
 * it may reach is the Polaris somebody named, requested at runtime. Asking GitHub
 * directly would mean a password manager holding standing permission to reach a
 * second host in order to read a version number. So it asks its own server, which
 * already performs and caches this lookup for the downloads page.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("../../src/", import.meta.url));
const EXTENSION = fileURLToPath(new URL("../../../extension/src/", import.meta.url));

const route = readFile(`${WEB}app/api/polaris/extension/route.ts`, "utf8");
const background = readFile(`${EXTENSION}entrypoints/background.ts`, "utf8");

describe("the route the extension asks", () => {
    it("reuses the lookup the downloads page already caches", async () => {
        const source = await route;
        expect(source).toContain('from "@/lib/app-releases"');
        expect(source).toContain("extensionDownload(loadEnv().POLARIS_REPO)");
    });

    it("asks for no session", async () => {
        // The extension holds none: its token is for the vault surface. Requiring
        // one would mean a locked vault could never find out it was out of date,
        // which is exactly when somebody should be told.
        const source = await route;
        expect(source).not.toContain("apiUser");
        expect(source).not.toContain("requireUser");
        expect(source).not.toContain("apiPermission");
    });

    it("answers with nulls rather than an error when nothing is published", async () => {
        const source = await route;
        expect(source).toContain("found?.version ?? null");
        expect(source).toContain("found?.url ?? null");
    });
});

describe("where the extension looks", () => {
    it("asks its own Polaris", async () => {
        const source = await background;
        expect(source).toContain("`${origin}/api/polaris/extension`");
    });

    it("never reaches for GitHub itself", async () => {
        // The permission decision, asserted rather than left to whoever edits
        // this next: a second host here is a second thing every install stands on.
        const source = await background;
        expect(source).not.toContain("api.github.com");
        expect(source).not.toContain("github.com");
    });

    it("checks on a slow alarm and when the browser starts, not when the popup opens", async () => {
        const source = await background;
        expect(source).toContain('browser.alarms.create("update-check"');
        expect(source).toContain("void checkForUpdate();");
        // The popup's request reads what the check left behind.
        expect(source).toContain("return { ok: true, update: await UPDATE.getValue() };");
    });
});

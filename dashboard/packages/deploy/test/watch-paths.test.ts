/**
 * Watch paths decide whether a push deploys a service, so a mistake here is either a
 * monorepo that redeploys everything on every commit or - far worse - a service that
 * silently stops deploying and looks like a broken webhook.
 *
 * The cases that matter are the defaults (nothing configured must keep deploying) and
 * the unknown (a changed-file list we could not obtain must not read as "nothing
 * changed").
 */

import { describe, expect, it } from "vitest";
import { parseWatchPaths, shouldDeployForPaths } from "../src/watch-paths.js";

describe("parsing the stored field", () => {
    it("takes one pattern per line, ignoring blanks and comments", () => {
        expect(parseWatchPaths("apps/web/**\n\n# the shared design system\npackages/ui/**\n")).toEqual([
            "apps/web/**",
            "packages/ui/**"
        ]);
    });

    it("treats an unset field as no patterns", () => {
        expect(parseWatchPaths(null)).toEqual([]);
        expect(parseWatchPaths("   ")).toEqual([]);
    });
});

describe("a service with no watch paths", () => {
    it("deploys on any push, which is what every existing service does", () => {
        expect(shouldDeployForPaths(["README.md"], [])).toBe(true);
    });
});

describe("a service watching its own directory", () => {
    const watch = ["apps/web/**"];

    it("deploys when something under it changed", () => {
        expect(shouldDeployForPaths(["apps/web/app/page.tsx"], watch)).toBe(true);
    });

    it("stays put when the push was somewhere else entirely", () => {
        expect(shouldDeployForPaths(["apps/api/main.go", "README.md"], watch)).toBe(false);
    });

    it("deploys when one file of many is its own", () => {
        expect(shouldDeployForPaths(["apps/api/main.go", "apps/web/package.json"], watch)).toBe(true);
    });

    it("reads a bare directory as everything under it", () => {
        expect(shouldDeployForPaths(["apps/web/page.tsx"], ["apps/web/"])).toBe(true);
    });
});

describe("a service built from a shared package", () => {
    const watch = ["apps/web/**", "packages/ui/**", "package-lock.json"];

    it("deploys when the package it depends on changed", () => {
        expect(shouldDeployForPaths(["packages/ui/src/button.tsx"], watch)).toBe(true);
    });

    it("deploys when the lockfile at the root changed", () => {
        expect(shouldDeployForPaths(["package-lock.json"], watch)).toBe(true);
    });

    it("ignores a package it is not built from", () => {
        expect(shouldDeployForPaths(["packages/mailer/src/send.ts"], watch)).toBe(false);
    });
});

describe("exclusions", () => {
    it("wins over an include that also matches", () => {
        expect(shouldDeployForPaths(["apps/web/README.md"], ["apps/web/**", "!**/*.md"])).toBe(false);
    });

    it("still deploys when another changed file is not excluded", () => {
        expect(shouldDeployForPaths(["apps/web/README.md", "apps/web/page.tsx"], ["apps/web/**", "!**/*.md"])).toBe(
            true
        );
    });

    it("on its own reads as everything except these", () => {
        expect(shouldDeployForPaths(["docs/guide.md"], ["!docs/**"])).toBe(false);
        expect(shouldDeployForPaths(["src/main.ts"], ["!docs/**"])).toBe(true);
    });
});

describe("glob syntax", () => {
    it("keeps a single star inside one path segment", () => {
        expect(shouldDeployForPaths(["config/prod.json"], ["config/*.json"])).toBe(true);
        expect(shouldDeployForPaths(["config/env/prod.json"], ["config/*.json"])).toBe(false);
    });

    it("lets a leading double star match at the root as well as deeper", () => {
        expect(shouldDeployForPaths(["README.md"], ["**/*.md"])).toBe(true);
        expect(shouldDeployForPaths(["docs/a/b.md"], ["**/*.md"])).toBe(true);
    });

    it("treats a regex metacharacter as the literal character", () => {
        expect(shouldDeployForPaths(["apps/web+api/main.ts"], ["apps/web+api/**"])).toBe(true);
        expect(shouldDeployForPaths(["apps/webbbapi/main.ts"], ["apps/web+api/**"])).toBe(false);
    });
});

describe("a push whose changed files could not be determined", () => {
    it("deploys rather than silently doing nothing", () => {
        // An empty list is "we do not know" - a webhook payload past GitHub's cap, a
        // compare call that failed. A redundant deploy is recoverable; a service that
        // quietly stops deploying is the failure nobody diagnoses.
        expect(shouldDeployForPaths([], ["apps/web/**"])).toBe(true);
    });
});

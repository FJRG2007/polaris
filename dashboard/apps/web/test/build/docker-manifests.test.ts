import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

/**
 * The image's dependency layer has to name every workspace.
 *
 * The Dockerfile copies the manifests one by one before `npm ci`, so that layer
 * is cached and only re-runs when dependencies change. The cost of that is a
 * list, and a list rots: a package added to `packages/` and not added here is one
 * `npm ci` never links into `node_modules`. It still builds - npm finds it by
 * path - but nothing that imports it can resolve it, so the failure lands on a
 * DIFFERENT package, as a missing module, in the image build alone. Every other
 * check in the repository passes.
 *
 * That is exactly what happened once, and it is why this is a test rather than a
 * comment: this is the only place the two lists are compared.
 */
describe("the image copies every workspace manifest", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    const dockerfile = readFileSync(join(root, "docker", "Dockerfile"), "utf8");

    const listed = new Set(
        [...dockerfile.matchAll(/COPY packages\/([a-z0-9-]+)\/package\.json/g)].map(
            (match) => match[1]
        )
    );
    const present = readdirSync(join(root, "packages"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => existsSync(join(root, "packages", name, "package.json")));

    it("names every package that exists", () => {
        expect([...present].filter((name) => !listed.has(name))).toEqual([]);
    });

    it("names nothing that does not", () => {
        expect([...listed].filter((name) => !present.includes(name))).toEqual([]);
    });
});

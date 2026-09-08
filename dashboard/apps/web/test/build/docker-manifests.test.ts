import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

/**
 * An image's dependency layer has to name every workspace it needs.
 *
 * Each Dockerfile copies workspace manifests one by one before `npm ci`, so that
 * layer is cached and only re-runs when dependencies change. The cost of that is
 * a list, and a list rots: a package added to `packages/` and not added here is
 * one `npm ci` never links into `node_modules`. It still builds - npm finds it by
 * path - but nothing that imports it can resolve it, so the failure lands on a
 * DIFFERENT package, as a missing module, in the image build alone. Every other
 * check in the repository passes.
 *
 * That is exactly what happened once, and it is why this is a test rather than a
 * comment: this is the only place the two lists are compared.
 *
 * Two rules, because the images are not the same shape. The dashboard's image
 * builds the whole workspace and so names all of it. A service image builds one
 * or two packages and names a subset - which is fine, and rots differently: it
 * copies a manifest whose own dependencies it does not copy, and that manifest
 * asks `npm ci` for a workspace that is not on the disk. Three service images
 * were doing that for months, each of them copying `apps/web` - which names
 * fourteen `@polaris` packages - while copying ten or twelve.
 */
describe("an image copies the manifests it needs", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    const read = (...path: string[]): string => readFileSync(join(root, ...path), "utf8");

    /** Every workspace directory that holds a manifest, by the name it publishes. */
    const workspaces = new Map<string, string>();
    for (const base of ["packages", "apps", "services"]) {
        for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const manifest = join(root, base, entry.name, "package.json");
            if (!existsSync(manifest)) continue;
            workspaces.set(
                JSON.parse(readFileSync(manifest, "utf8")).name,
                `${base}/${entry.name}`
            );
        }
    }

    /** What one workspace asks for from the rest of the workspace. */
    const internalDeps = (directory: string): string[] => {
        const manifest = JSON.parse(read(directory, "package.json"));
        const named = { ...manifest.dependencies, ...manifest.devDependencies };
        return Object.keys(named).filter((name) => name.startsWith("@polaris/"));
    };

    /** The manifests one Dockerfile copies in. */
    const copiedBy = (dockerfile: string): Set<string> =>
        new Set(
            [
                ...read(dockerfile).matchAll(
                    /^COPY ((?:packages|apps|services)\/[a-z0-9-]+)\/package\.json/gm
                )
            ].map((match) => match[1])
        );

    const images = [
        "docker/Dockerfile",
        "services/edge-guard/Dockerfile",
        "services/messaging-bridge/Dockerfile",
        "services/vision/Dockerfile"
    ];

    it.each(images)("%s names what the manifests it copies ask for", (dockerfile) => {
        const copied = copiedBy(dockerfile);
        expect(copied.size, `${dockerfile} copies no workspace manifest`).toBeGreaterThan(0);
        const missing = new Set<string>();
        for (const directory of copied) {
            for (const dependency of internalDeps(directory)) {
                const home = workspaces.get(dependency);
                if (home && !copied.has(home)) missing.add(home);
            }
        }
        expect([...missing].sort()).toEqual([]);
    });

    it.each(images)("%s names nothing that is not there", (dockerfile) => {
        const present = new Set(workspaces.values());
        expect([...copiedBy(dockerfile)].filter((named) => !present.has(named))).toEqual([]);
    });

    it("the dashboard's own image names every package, because it builds them all", () => {
        // The one image where the list really is the whole workspace: `npm run
        // build` walks every member, so a missing manifest here is the failure
        // described above rather than a subset chosen on purpose.
        const copied = copiedBy("docker/Dockerfile");
        const packages = [...workspaces.values()].filter((named) =>
            named.startsWith("packages/")
        );
        expect(packages.filter((named) => !copied.has(named))).toEqual([]);
    });
});

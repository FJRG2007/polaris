import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The host daemon and the one-shot updater run the same Docker CLI.
 *
 * Both images download Docker's own CLI, compose and buildx release binaries,
 * pinned by version and SHA-256. The updater rebuilds and redeploys what hostd
 * deploys, so a bump made in one file and not the other leaves the two driving
 * the engine with different tools. The updater also needs buildx: compose hands
 * every build to it, and a source-built deployment is rebuilt by the updater.
 */
describe("the Docker CLI pins", () => {
    const repo = join(__dirname, "..", "..", "..", "..", "..");
    const args = (...path: string[]): Map<string, string> => {
        const text = readFileSync(join(repo, ...path), "utf8");
        const found = new Map<string, string>();
        for (const match of text.matchAll(/^ARG ((?:DOCKER|COMPOSE|BUILDX)_[A-Z0-9_]+)=(\S+)$/gm)) {
            found.set(match[1]!, match[2]!);
        }
        return found;
    };

    const hostd = args("crates", "polaris-hostd", "Dockerfile");
    const updater = args("dashboard", "docker", "updater", "Dockerfile");

    it("pins the CLI, compose and buildx in the host daemon's image", () => {
        for (const tool of ["DOCKER", "COMPOSE", "BUILDX"]) {
            for (const suffix of ["VERSION", "SHA256_AMD64", "SHA256_ARM64"]) {
                expect(hostd.get(`${tool}_${suffix}`), `${tool}_${suffix}`).toBeTruthy();
            }
        }
    });

    it("pins the same versions and checksums in the updater", () => {
        expect(Object.fromEntries(updater)).toEqual(Object.fromEntries(hostd));
    });
});

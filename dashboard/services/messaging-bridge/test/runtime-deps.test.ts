import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The runtime image installs the adapters' packages by name and version in its
 * Dockerfile, outside the lockfile. A version bumped in package.json and not
 * there ships the old one - the advisory the bump fixed included - while every
 * check on the repository says the new one is in use.
 */

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("runtime image dependencies", () => {
    const manifest = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const install = /npm install --omit=dev ([^&\n]+)/.exec(read("Dockerfile"))?.[1] ?? "";
    const pinned = new Map(
        install
            .trim()
            .split(/\s+/)
            .map((spec) => {
                const at = spec.lastIndexOf("@");
                return [spec.slice(0, at), spec.slice(at + 1)] as const;
            })
    );

    it("installs every external runtime dependency", () => {
        const external = Object.keys(manifest.dependencies).filter((name) => !name.startsWith("@polaris/"));
        expect([...pinned.keys()].sort()).toEqual(external.sort());
    });

    it.each(Object.entries(manifest.dependencies).filter(([name]) => !name.startsWith("@polaris/")))(
        "installs %s at the version package.json pins",
        (name, version) => {
            expect(pinned.get(name)).toBe(version);
        }
    );
});

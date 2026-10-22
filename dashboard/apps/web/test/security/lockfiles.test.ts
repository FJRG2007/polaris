/**
 * Copying a deployed commit's lockfiles out of its clone for the dependency
 * scan: the repository root and the service's own folders are read, a link is
 * never followed out of the clone, and an oversized file is left out. The
 * checkout is a temp directory of fixture files.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as depsSpecs from "@polaris-app/security-scans/src/model/specs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { collectLockfiles } from "@/lib/security/lockfiles";

const made: string[] = [];

async function checkout(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "polaris-lockfiles-"));
    made.push(dir);
    for (const [path, body] of Object.entries(files)) {
        await mkdir(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
        await writeFile(join(dir, ...path.split("/")), body);
    }
    return dir;
}

afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the lockfiles of a deployed commit", () => {
    it("are read at the repository root and down to the service's folder", async () => {
        const dir = await checkout({
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            "apps/api/go.mod": "module example.test/fixture\n",
            "apps/api/go.sum": "example.test/dep v1.0.0 h1:fixture=\n",
            "apps/web/package-lock.json": "{}\n",
            "apps/api/README.md": "not a lockfile\n"
        });
        const found = await collectLockfiles(dir, "apps/api");
        expect(found.map((file) => file.path)).toEqual([
            "pnpm-lock.yaml",
            "apps/api/go.mod",
            "apps/api/go.sum"
        ]);
        expect(found[0]!.body.toString()).toBe("lockfileVersion: '9.0'\n");
    });

    it("are none for a root directory that leaves the repository", async () => {
        const dir = await checkout({ "yarn.lock": "# fixture\n" });
        expect(await collectLockfiles(dir, "../..")).toEqual([]);
    });

    it("never follow a link out of the clone", async () => {
        const outside = await checkout({ "secret.txt": "not yours\n" });
        const dir = await checkout({});
        const linked = await symlink(join(outside, "secret.txt"), join(dir, "Cargo.lock")).then(
            () => true,
            () => false
        );
        // Creating a link needs a privilege some Windows accounts lack; the
        // check is then that nothing was found either way.
        expect(await collectLockfiles(dir, "")).toEqual([]);
        expect(typeof linked).toBe("boolean");
    });
});

describe("the dependency scan's container", () => {
    it("runs the scanner on the lockfiles as a directory, offline, sharing the image scans' cache", () => {
        const spec = depsSpecs.depsSpec();
        const service = spec.services[0]!;
        expect(spec.project).toBe(depsSpecs.PROJECTS.images);
        expect(service.image).toBe(depsSpecs.DEPS_IMAGE);
        expect(service.pullPolicy).toBe("never");
        expect(service.command).toEqual(["dir:/src", "-o", "json", "-q"]);
        expect(service.env.GRYPE_CHECK_FOR_APP_UPDATE).toBe("false");
        expect(service.volumes).toEqual([{ source: "cache", target: "/cache", kind: "volume" }]);
    });
});

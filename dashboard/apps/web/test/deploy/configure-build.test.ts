/**
 * What a clone of a non-JavaScript project gets written into its build context.
 *
 * Run against a real directory, because the part worth pinning is the reading -
 * the manifests found on disk, capped, and handed to detection - and whether a
 * service that never asked for it is left on the builder it already deploys with.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureBuild } from "../../src/lib/git-build-service";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";

let dir = "";
let outside = "";

/** A directory beside the checkout, standing for the rest of this machine. */
async function elsewhere(files: Record<string, string>): Promise<string> {
    outside = await mkdtemp(join(tmpdir(), "polaris-outside-"));
    for (const [name, text] of Object.entries(files)) await writeFile(join(outside, name), text, "utf8");
    return outside;
}

const VITE_MANIFEST = JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "5" } });

async function repo(files: Record<string, string>): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "polaris-configure-"));
    for (const [name, text] of Object.entries(files)) {
        const path = join(dir, name);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, text, "utf8");
    }
    return dir;
}

afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
    dir = "";
    outside = "";
});

describe("a Python service created since the other languages were detected", () => {
    it("is built from a generated image on the version the repository pins", async () => {
        const root = await repo({
            "requirements.txt": "flask==3.0\n",
            "app.py": "from flask import Flask\napp = Flask(__name__)\n",
            ".python-version": "3.11\n"
        });
        const said: string[] = [];
        const result = await configureBuild(root, { port: 5000, languages: true }, (line) => said.push(line));
        expect(result.dockerfile).toBe("Dockerfile.polaris");
        const dockerfile = await readFile(join(root, "Dockerfile.polaris"), "utf8");
        expect(dockerfile).toContain("FROM python:3.11-slim");
        expect(dockerfile).toContain("gunicorn app:app --bind 0.0.0.0:$PORT");
        expect(said.join("")).toContain("Detected Flask");
    });

    it("builds on the runtime version the service set over the repository's", async () => {
        const root = await repo({ "requirements.txt": "flask\n", "app.py": "", ".python-version": "3.11" });
        await configureBuild(root, { port: 5000, languages: true, runtimeVersion: "3.12" }, () => undefined);
        expect(await readFile(join(root, "Dockerfile.polaris"), "utf8")).toContain("FROM python:3.12-slim");
    });
});

describe("a service the builder already deploys", () => {
    it("stays on the builder", async () => {
        const root = await repo({ "requirements.txt": "flask\n", "app.py": "" });
        const result = await configureBuild(root, { port: 5000 }, () => undefined);
        expect(result.dockerfile).toBeUndefined();
    });
});

/**
 * A repository is somebody else's files, symlinks included, and the clone sits on
 * the machine Polaris runs on. Nothing it ships may make detection read a file of
 * that machine's, or aim a generated file at one.
 */
describe("a repository that ships symlinks", () => {
    it("does not read a package.json that links out of the checkout", async () => {
        const host = await elsewhere({ "package.json": VITE_MANIFEST });
        const root = await repo({});
        await symlink(join(host, "package.json"), join(root, "package.json"), "file");

        const said: string[] = [];
        const result = await configureBuild(root, { port: 8080 }, (line) => said.push(line));

        expect(result.dockerfile).toBeUndefined();
        expect(said.join("")).not.toContain("Detected");
    });

    it("does not read a go.mod that links out of the checkout", async () => {
        const host = await elsewhere({ "go.mod": "module example.com/app\n\ngo 1.22\n" });
        const root = await repo({ "main.go": "package main\n" });
        await symlink(join(host, "go.mod"), join(root, "go.mod"), "file");

        await configureBuild(root, { port: 8080, languages: true }, () => undefined);

        // Built as a module with no go line, because its text was never read.
        const dockerfile = await readFile(join(root, "Dockerfile.polaris"), "utf8");
        expect(dockerfile).toContain("FROM golang:1");
        expect(dockerfile).not.toContain("golang:1.22");
    });

    it("does not read a manifest larger than a manifest is", async () => {
        const root = await repo({
            "main.go": "package main\n",
            "go.mod": `module example.com/app\n\ngo 1.22\n${"// padding\n".repeat(8000)}`
        });
        await configureBuild(root, { port: 8080, languages: true }, () => undefined);
        expect(await readFile(join(root, "Dockerfile.polaris"), "utf8")).not.toContain("golang:1.22");
    });

    it("still reads a go.mod the repository really holds", async () => {
        const root = await repo({ "main.go": "package main\n", "go.mod": "module example.com/app\n\ngo 1.22\n" });
        await configureBuild(root, { port: 8080, languages: true }, () => undefined);
        expect(await readFile(join(root, "Dockerfile.polaris"), "utf8")).toContain("golang:1.22");
    });

    it("does not look in a service directory that links out of the checkout", async () => {
        const host = await elsewhere({ "package.json": VITE_MANIFEST });
        const root = await repo({ "README.md": "" });
        await symlink(host, join(root, "web"), "junction");

        await expect(
            configureBuild(root, { rootDirectory: "web", port: 8080, startCommand: "node server.js" }, () => undefined)
        ).rejects.toThrow("outside the repository");
        expect(await readdir(host)).toEqual(["package.json"]);
    });

    it("does not follow a service directory that climbs out with ..", async () => {
        const host = await elsewhere({ "package.json": VITE_MANIFEST });
        const root = await repo({ "README.md": "" });
        const climb = `../${host.split(/[\\/]/).pop()}`;

        await expect(
            configureBuild(root, { rootDirectory: climb, port: 8080, startCommand: "node server.js" }, () => undefined)
        ).rejects.toThrow("outside the repository");
        expect(await readdir(host)).toEqual(["package.json"]);
    });

    it("writes the generated Dockerfile over a link rather than through it", async () => {
        const host = await elsewhere({ "victim.txt": "untouched\n" });
        const root = await repo({ "package.json": VITE_MANIFEST });
        await symlink(join(host, "victim.txt"), join(root, "Dockerfile.polaris"), "file");

        const result = await configureBuild(root, { port: 8080 }, () => undefined);

        expect(result.dockerfile).toBe("Dockerfile.polaris");
        expect(await readFile(join(host, "victim.txt"), "utf8")).toBe("untouched\n");
        expect((await lstat(join(root, "Dockerfile.polaris"))).isFile()).toBe(true);
        expect(await readFile(join(root, "Dockerfile.polaris"), "utf8")).toContain("FROM ");
    });
});

describe("a built site with an output directory of its own", () => {
    it("serves the directory the service names instead of the framework's", async () => {
        const root = await repo({
            "package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "5" } })
        });
        await configureBuild(root, { port: 8080, outputDirectory: "public-build" }, () => undefined);
        expect(await readFile(join(root, "Dockerfile.polaris"), "utf8")).toContain("/workspace/public-build /usr/share/nginx/html");
    });
});

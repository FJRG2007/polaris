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
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";

let dir = "";

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
    dir = "";
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

describe("a built site with an output directory of its own", () => {
    it("serves the directory the service names instead of the framework's", async () => {
        const root = await repo({
            "package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "5" } })
        });
        await configureBuild(root, { port: 8080, outputDirectory: "public-build" }, () => undefined);
        expect(await readFile(join(root, "Dockerfile.polaris"), "utf8")).toContain("/workspace/public-build /usr/share/nginx/html");
    });
});

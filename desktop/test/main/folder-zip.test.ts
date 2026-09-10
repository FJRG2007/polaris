/**
 * A folder zipped for "Upload a folder": the same exclusions as the dashboard's
 * browser zipper, the same shape (everything under the folder's own name), and
 * the same refusals.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { FolderRefusal, listFolder, zipEntries, zipFolder } from "@/main/folder-zip";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
    EMPTY_FOLDER,
    FOLDER_TOO_LARGE,
    MAX_FOLDER,
    MAX_ZIP,
    ZIP_TOO_LARGE,
    formatBytes,
    skipped
} from "@/main/zip-rules";

describe("skipped", () => {
    it("leaves out node_modules, .git and __MACOSX at any depth, with everything under them", () => {
        expect(skipped("app/node_modules")).toBe(true);
        expect(skipped("app/node_modules/react/index.js")).toBe(true);
        expect(skipped("app/packages/web/node_modules/x.js")).toBe(true);
        expect(skipped("app/.git/HEAD")).toBe(true);
        expect(skipped("app/__MACOSX/._index.js")).toBe(true);
    });

    it("leaves out .DS_Store, as the browser zipper does - by the end of the path", () => {
        expect(skipped("app/.DS_Store")).toBe(true);
        expect(skipped("app/src/.DS_Store")).toBe(true);
    });

    it("keeps names that only contain a skipped word", () => {
        expect(skipped("app/node_modules_backup/x.js")).toBe(false);
        expect(skipped("app/.github/workflows/ci.yml")).toBe(false);
        expect(skipped("app/.gitignore")).toBe(false);
        expect(skipped("app/src/git.ts")).toBe(false);
    });
});

describe("parity with the dashboard's browser zipper", () => {
    // The two cannot share code - this app is its own project - so the copy is
    // checked against the original instead of trusted to stay in step.
    const browser = readFileSync(
        join(__dirname, "../../../dashboard/apps/web/src/app/(app)/apps/deploy/upload-source.tsx"),
        "utf8"
    );
    const mine = readFileSync(join(__dirname, "../../src/main/zip-rules.ts"), "utf8");
    const line = (source: string, pattern: RegExp) =>
        pattern.exec(source)?.[0]?.replace(/^export /, "");

    it("skips the same entries and keeps the same limits", () => {
        for (const pattern of [
            /(export )?const SKIPPED = .*;/,
            /(export )?const MAX_ZIP = .*;/,
            /(export )?const MAX_FOLDER = .*;/
        ]) {
            expect(line(mine, pattern)).toBeDefined();
            expect(line(mine, pattern)).toBe(line(browser, pattern));
        }
        expect(browser).toContain(
            'path.split("/").some((segment) => SKIPPED.has(segment)) || path.endsWith(".DS_Store")'
        );
        expect(mine).toContain(
            'path.split("/").some((segment) => SKIPPED.has(segment)) || path.endsWith(".DS_Store")'
        );
    });
});

describe("the limits", () => {
    it("match the dashboard: 200 MB zipped, 1 GB before", () => {
        expect(MAX_ZIP).toBe(200 * 1024 ** 2);
        expect(MAX_FOLDER).toBe(1024 ** 3);
        expect(FOLDER_TOO_LARGE).toBe("That folder holds more than 1 GB.");
        expect(ZIP_TOO_LARGE).toBe("Zipped, that folder is larger than 200 MB.");
        expect(formatBytes(1536)).toBe("1.5 KB");
        expect(formatBytes(12)).toBe("12 B");
    });
});

describe("zipFolder", () => {
    let root: string | null = null;

    afterEach(() => {
        if (root) rmSync(root, { recursive: true, force: true });
        root = null;
    });

    function project(): string {
        root = mkdtempSync(join(tmpdir(), "polaris-zip-"));
        const app = join(root, "my-app");
        for (const dir of [
            "src/lib",
            "node_modules/react",
            ".git/objects",
            "packages/web/node_modules/x",
            ".github"
        ]) {
            mkdirSync(join(app, dir), { recursive: true });
        }
        writeFileSync(join(app, "package.json"), '{"name":"my-app"}');
        writeFileSync(join(app, "src/index.ts"), "export const a = 1;\n");
        writeFileSync(join(app, "src/lib/util.ts"), "export const b = 2;\n");
        writeFileSync(join(app, ".github/ci.yml"), "on: push\n");
        writeFileSync(join(app, ".gitignore"), "node_modules\n");
        writeFileSync(join(app, ".DS_Store"), "junk");
        writeFileSync(join(app, "node_modules/react/index.js"), "module.exports = {};\n");
        writeFileSync(join(app, ".git/HEAD"), "ref: refs/heads/main\n");
        writeFileSync(join(app, "packages/web/node_modules/x/y.js"), "1");
        return app;
    }

    it("zips everything under the folder's own name, without the skipped entries", async () => {
        const zipped = await zipFolder(project());
        const files = unzipSync(zipped.zip);
        expect(Object.keys(files).sort()).toEqual([
            "my-app/.github/ci.yml",
            "my-app/.gitignore",
            "my-app/package.json",
            "my-app/src/index.ts",
            "my-app/src/lib/util.ts"
        ]);
        expect(zipped.name).toBe("my-app");
        expect(zipped.files).toBe(5);
        expect(strFromU8(files["my-app/src/index.ts"] as Uint8Array)).toBe("export const a = 1;\n");
    });

    it("does not follow links out of the folder", async () => {
        const app = project();
        const outside = join(root as string, "secret.txt");
        writeFileSync(outside, "do not send");
        try {
            symlinkSync(outside, join(app, "linked.txt"));
        } catch {
            // Creating links needs a privilege Windows does not give everyone; the
            // walk still never follows one, which is what the other platforms check.
            return;
        }
        const names = (await listFolder(app)).map((entry) => entry.path);
        expect(names).not.toContain("my-app/linked.txt");
    });

    it("follows a link to a file inside the folder", async () => {
        const app = project();
        try {
            symlinkSync(join(app, "src/index.ts"), join(app, "entry.ts"));
        } catch {
            return;
        }
        const entries = await listFolder(app);
        expect(entries.map((entry) => entry.path)).toContain("my-app/entry.ts");
        const files = unzipSync(await zipEntries(entries));
        expect(strFromU8(files["my-app/entry.ts"] as Uint8Array)).toBe("export const a = 1;\n");
    });

    it("follows a link to a folder inside the folder, and not one outside it", async () => {
        const app = project();
        const outside = join(root as string, "elsewhere");
        mkdirSync(outside);
        writeFileSync(join(outside, "secret.txt"), "do not send");
        // A junction is a link Windows lets anybody make; elsewhere the type is ignored.
        symlinkSync(join(app, "src/lib"), join(app, "shared"), "junction");
        symlinkSync(outside, join(app, "outside"), "junction");
        const names = (await listFolder(app)).map((entry) => entry.path);
        expect(names).toContain("my-app/shared/util.ts");
        expect(names).toContain("my-app/src/lib/util.ts");
        expect(names.some((name) => name.startsWith("my-app/outside"))).toBe(false);
    });

    it("ends a loop of links", async () => {
        const app = project();
        symlinkSync(app, join(app, "src/lib/up"), "junction");
        symlinkSync(join(app, "src"), join(app, "src/lib/again"), "junction");
        mkdirSync(join(app, "a"));
        mkdirSync(join(app, "b"));
        writeFileSync(join(app, "b/b.txt"), "b");
        symlinkSync(join(app, "b"), join(app, "a/to-b"), "junction");
        symlinkSync(join(app, "a"), join(app, "b/to-a"), "junction");
        const names = (await listFolder(app)).map((entry) => entry.path);
        expect(names.some((name) => name.includes("/up/") || name.includes("/again/"))).toBe(false);
        expect(names).toContain("my-app/b/b.txt");
        expect(names).toContain("my-app/a/to-b/b.txt");
        expect(new Set(names).size).toBe(names.length);
    });

    it("refuses a folder with nothing to send", async () => {
        root = mkdtempSync(join(tmpdir(), "polaris-zip-"));
        const empty = join(root, "empty");
        mkdirSync(join(empty, "node_modules/x"), { recursive: true });
        writeFileSync(join(empty, "node_modules/x/a.js"), "1");
        await expect(zipFolder(empty)).rejects.toEqual(new FolderRefusal(EMPTY_FOLDER));
    });

    it("refuses a zip that would pass the server's limit", async () => {
        root = mkdtempSync(join(tmpdir(), "polaris-zip-"));
        const file = join(root, "noise.bin");
        // Random bytes do not compress, so the zip is as large as the file.
        const size = MAX_ZIP + 1024;
        const chunk = new Uint8Array(1024 * 1024).map(() => Math.floor(Math.random() * 256));
        const bytes = new Uint8Array(size);
        for (let at = 0; at < size; at += chunk.length)
            bytes.set(chunk.subarray(0, Math.min(chunk.length, size - at)), at);
        writeFileSync(file, bytes);
        await expect(
            zipEntries([{ path: "big/noise.bin", file, size, mtime: new Date() }])
        ).rejects.toEqual(new FolderRefusal(ZIP_TOO_LARGE));
    }, 60_000);
});

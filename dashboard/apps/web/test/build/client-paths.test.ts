/**
 * The browser bundle never carries a path from the machine that built it.
 *
 * Webpack compiles a bare `import.meta.url` to the module's absolute `file://`
 * URL, and pdf.js reads one, which published the builder's
 * account name and disk layout to every visitor. The plugin swaps it for a
 * workspace-relative URL in the client build, and the postbuild check fails the
 * build if a path gets through anyway; these pin both halves.
 */
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { portableModuleUrl } from "../../scripts/portable-import-meta.mjs";
import { findLeaks, spellings } from "../../scripts/check-client-paths.mjs";

const root = resolve("/", "srv", "builder", "polaris", "dashboard");

describe("portableModuleUrl", () => {
    it("answers with the module's path relative to the workspace", () => {
        const resource = join(root, "node_modules", "pdfjs-dist", "build", "pdf.mjs");
        expect(portableModuleUrl(resource, root)).toBe("file:///node_modules/pdfjs-dist/build/pdf.mjs");
    });

    it("falls back to the file name for a module outside the workspace", () => {
        const resource = join("/", "opt", "elsewhere", "lib", "worker.js");
        expect(portableModuleUrl(resource, root)).toBe("file:///worker.js");
    });

    it("never contains the workspace path", () => {
        const url = portableModuleUrl(join(root, "apps", "web", "src", "page.tsx"), root);
        for (const form of spellings(root)) expect(url).not.toContain(form);
    });
});

describe("check-client-paths", () => {
    it("finds the path however the bundler spelled it", () => {
        const needles = spellings(root);
        for (const written of [
            `new URL("${pathToFileURL(join(root, "x.js")).href}")`,
            JSON.stringify({ file: join(root, "x.js") }),
            `"${root.replaceAll("\\", "/")}/x.js"`
        ]) {
            expect(findLeaks(written, needles).length, written).toBeGreaterThan(0);
        }
    });

    it("leaves a bundle with only relative URLs alone", () => {
        const bundle = 'createRequire("file:///node_modules/pdfjs-dist/build/pdf.mjs");n.push("file:///C:/SheetJS/")';
        expect(findLeaks(bundle, spellings(root))).toEqual([]);
    });

    it("does not take a workspace at a top-level directory for every URL that names it", () => {
        const needles = [...spellings(resolve("/build")), ...spellings(resolve("/root"))];
        const bundle = 'createRequire("file:///node_modules/pdfjs-dist/build/pdf.mjs");fetch("/build/prune?all=true");n.push("/root")';
        expect(findLeaks(bundle, needles)).toEqual([]);
        expect(findLeaks(`new URL("${pathToFileURL(resolve("/build", "x.js")).href}")`, needles).length).toBeGreaterThan(0);
    });

    it("matches only a whole path, not a longer one that starts with it", () => {
        const needles = spellings(root);
        expect(findLeaks(`"${root.replaceAll("\\", "/")}-old/x.js"`, needles)).toEqual([]);
        expect(findLeaks(`"/mirror${root.replaceAll("\\", "/")}/x.js"`, needles)).toEqual([]);
    });

    it("ignores paths too short to mean anything", () => {
        expect(spellings("/")).toEqual([]);
    });
});

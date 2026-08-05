/**
 * Where the agent runtime is found on a packaged instance.
 *
 * The failure this guards is invisible in development: resolving the package by
 * name works from the repository and does not work in the image, because Next's
 * standalone tracer lays the package down under its real path and reproduces no
 * `node_modules/@polaris/agent-runtime` entry. Every run then dies at its first
 * step downloading a 503, and the only place it reproduces is the deployment.
 *
 * The route is a Next handler, so what is exercised here is the resolution rule
 * it uses, against a tree shaped like the one in the image.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/** The candidate list the route walks, in its order. Kept in step with
 *  `bundleDir` in the route; the point of the test is the standalone layout. */
function bundleDir(cwd: string, resolved: string | null): string | null {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    const candidates = [
        ...(resolved ? [resolved] : []),
        join(cwd, "packages", "agent-runtime", "dist"),
        join(cwd, "..", "..", "packages", "agent-runtime", "dist")
    ];
    return candidates.find((dir) => existsSync(join(dir, "runtime.mjs"))) ?? null;
}

const roots: string[] = [];

function tree(relative: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "bundle-"));
    roots.push(root);
    const dir = join(root, ...relative);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "runtime.mjs"), "// runtime");
    writeFileSync(join(dir, "post.mjs"), "// post");
    return root;
}

afterEach(() => {
    roots.length = 0;
});

describe("bundleDir", () => {
    it("finds the runtime where the standalone tree puts it", () => {
        // What the image actually looks like: the server runs from the workspace
        // root and the package sits beside the app, not under it.
        const root = tree(["packages", "agent-runtime", "dist"]);
        expect(bundleDir(root, null)).toBe(join(root, "packages", "agent-runtime", "dist"));
    });

    it("prefers what the resolver answered, because that is right when it answers", () => {
        const root = tree(["packages", "agent-runtime", "dist"]);
        const installed = tree(["node_modules", "@polaris", "agent-runtime", "dist"]);
        const resolved = join(installed, "node_modules", "@polaris", "agent-runtime", "dist");
        expect(bundleDir(root, resolved)).toBe(resolved);
    });

    it("answers null when the runtime was never built", () => {
        // The route turns this into a 503 that names the reason, rather than
        // serving an error page a runner would then execute.
        const root = mkdtempSync(join(tmpdir(), "bundle-"));
        roots.push(root);
        expect(bundleDir(root, null)).toBeNull();
    });

    it("does not take a directory that has the package but no build", () => {
        const root = mkdtempSync(join(tmpdir(), "bundle-"));
        roots.push(root);
        mkdirSync(join(root, "packages", "agent-runtime", "dist"), { recursive: true });
        expect(bundleDir(root, null)).toBeNull();
    });
});

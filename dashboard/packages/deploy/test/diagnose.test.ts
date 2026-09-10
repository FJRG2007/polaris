/**
 * Reading a failed deploy's log for its cause and the setting that fixes it.
 *
 * Every log here is shaped the way the tool in question prints it - npm, pnpm,
 * nixpacks, Docker, Next.js, pip, Prisma, Rails, Laravel - including the noise
 * around the line that matters, because the rule has to find that line in a real
 * log and not in a sentence written for the test.
 */

import { describe, expect, it } from "vitest";
import { diagnoseDeploy } from "../src/diagnose.js";

/** A log with the build's ordinary chatter around the line that matters. */
function log(...lines: string[]): string {
    return [
        "==> Cloning with no connected account - a private repository will refuse this.",
        "Cloning into '/tmp/polaris-build-abc'...",
        "==> Building on node:22-slim.",
        "#5 [2/6] WORKDIR /workspace",
        ...lines,
        "==> Failed: build failed"
    ].join("\n");
}

describe("what the project printed", () => {
    it("offers a start command when there is no start script", () => {
        const found = diagnoseDeploy(log("npm error Missing script: \"start\"", "npm error", "npm error To see a list of scripts, run:"));
        expect(found?.cause).toBe("missing-start-script");
        expect(found?.fix).toEqual({ kind: "set-start-command", suggestion: null });
        expect(found?.evidence).toBe('npm error Missing script: "start"');
    });

    it("recognizes nixpacks having nothing to start", () => {
        expect(diagnoseDeploy(log("Error: No start command could be found"))?.cause).toBe("missing-start-script");
    });

    it("raises Node's heap when the build runs out of it", () => {
        const found = diagnoseDeploy(
            log("<--- Last few GCs --->", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory")
        );
        expect(found?.fix).toEqual({ kind: "add-variable", name: "NODE_OPTIONS", value: "--max-old-space-size=4096", generate: false });
    });

    it("builds on the Node version Next.js asks for", () => {
        const found = diagnoseDeploy(
            log('You are using Node.js 18.17.0. For Next.js, Node.js version "^18.18.0 || ^19.8.0 || >= 20.0.0" is required.')
        );
        expect(found?.cause).toBe("node-version");
        expect(found?.fix).toEqual({ kind: "set-runtime-version", version: "20" });
    });

    it("reads yarn's engine refusal", () => {
        const found = diagnoseDeploy(
            log('error astro@5.1.0: The engine "node" is incompatible with this module. Expected version ">=22.12.0". Got "22.3.0"')
        );
        expect(found?.fix).toEqual({ kind: "set-runtime-version", version: "22" });
    });

    it("builds on the Python version pip says the project needs", () => {
        const found = diagnoseDeploy(log("ERROR: Package 'api' requires a different Python: 3.9.18 not in '>=3.11'"));
        expect(found?.fix).toEqual({ kind: "set-runtime-version", version: "3.11" });
    });

    it("names the variable Prisma could not find", () => {
        const found = diagnoseDeploy(
            log("Error: Prisma schema validation - (get-config wasm)", "error: Environment variable not found: DATABASE_URL.")
        );
        expect(found?.fix).toEqual({ kind: "add-variable", name: "DATABASE_URL", value: null, generate: false });
    });

    it("names the variable Python read from the environment", () => {
        const found = diagnoseDeploy(log("Traceback (most recent call last):", '  File "/workspace/app.py", line 4', "KeyError: 'STRIPE_SECRET'"));
        expect(found?.fix).toMatchObject({ kind: "add-variable", name: "STRIPE_SECRET" });
    });

    it("generates the secret Laravel, Rails and Django refuse to start without", () => {
        expect(diagnoseDeploy(log("Illuminate\\Encryption\\MissingAppKeyException: No application encryption key has been specified."))?.fix).toEqual({
            kind: "add-variable",
            name: "APP_KEY",
            value: null,
            generate: true
        });
        expect(diagnoseDeploy(log("ArgumentError: Missing `secret_key_base` for 'production' environment"))?.fix).toMatchObject({ name: "SECRET_KEY_BASE", generate: true });
        expect(diagnoseDeploy(log("django.core.exceptions.ImproperlyConfigured: The SECRET_KEY setting must not be empty."))?.fix).toMatchObject({ name: "SECRET_KEY" });
    });

    it("sends a missing Dockerfile to the detected build", () => {
        const found = diagnoseDeploy(log("ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory"));
        expect(found?.fix).toEqual({ kind: "use-detected-build" });
    });

    it("asks for the root directory when the build found no project", () => {
        const found = diagnoseDeploy(
            log("npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/workspace/package.json'")
        );
        expect(found?.fix).toEqual({ kind: "set-root-directory", suggestion: null });
    });

    it("says which tool the build could not find", () => {
        const found = diagnoseDeploy(log("> web@0.1.0 build", "> vite build", "sh: 1: vite: not found"));
        expect(found?.title).toContain("vite");
        expect(found?.fix).toEqual({ kind: "set-build-command", suggestion: null });
    });

    it("tells a missing dependency from missing build output", () => {
        expect(diagnoseDeploy(log("Error: Cannot find module 'express'"))?.fix).toBeNull();
        expect(diagnoseDeploy(log("Error: Cannot find module '/workspace/dist/server.js'"))?.fix).toEqual({ kind: "set-start-command", suggestion: null });
        expect(diagnoseDeploy(log("ModuleNotFoundError: No module named 'gunicorn'"))?.title).toContain("gunicorn");
    });

    it("points the service at the port the app actually listens on", () => {
        const found = diagnoseDeploy(log("> start", "Server listening on port 8080"), { port: 3000 });
        expect(found?.fix).toEqual({ kind: "set-port", port: 8080 });
        expect(diagnoseDeploy(log("Server listening on port 3000"), { port: 3000 })).toBeNull();
    });

    it("sets HOST when the app only listens on localhost", () => {
        const found = diagnoseDeploy(log("  Local:   http://localhost:4321/", "Server running on http://localhost:4321"));
        expect(found?.fix).toEqual({ kind: "add-variable", name: "HOST", value: "0.0.0.0", generate: false });
    });
});

describe("what it leaves alone", () => {
    it("does not blame the lockfile when the install already fell back past it", () => {
        const recovered = log(
            "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"",
            "Lockfile does not match the manifest; installing from the manifest instead."
        );
        expect(diagnoseDeploy(recovered)).toBeNull();
        expect(diagnoseDeploy(log("ERR_PNPM_OUTDATED_LOCKFILE  Cannot install"))?.cause).toBe("lockfile-mismatch");
    });

    it("answers nothing for a log it does not recognize", () => {
        expect(diagnoseDeploy(log("error: something only this project knows about"))).toBeNull();
    });

    it("reads through colour codes and keeps only the line that matters", () => {
        const coloured = "\x1b[31mnpm error\x1b[39m Missing script: \"start\"";
        expect(diagnoseDeploy(coloured)?.evidence).toBe('npm error Missing script: "start"');
    });
});

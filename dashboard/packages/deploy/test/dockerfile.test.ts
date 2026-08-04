/**
 * The Dockerfile Polaris writes for a repository that has no one.
 *
 * This replaced four attempts at steering the machine's auto-detecting builder,
 * every one of which broke something. The reason it works where those did not is
 * that an image tag is not a pin: `node:22-slim` is the current 22.x whenever it
 * is pulled, so a project that declares what it needs gets it - where the builder
 * could only ever offer the release its own version was frozen against.
 */

import { describe, expect, it } from "vitest";
import { generateDockerfile, type DockerfilePlan } from "../src/dockerfile.js";

/** A server-style plan; overrides replace individual fields. */
function plan(overrides: Partial<DockerfilePlan> = {}): DockerfilePlan {
    return {
        buildImage: "node:22-slim",
        runtimeImage: "node:22-slim",
        appDirectory: "",
        workspaceInstall: null,
        install: "npm ci",
        build: "npm run build",
        start: "npm run start",
        staticDirectory: null,
        port: 3000,
        ...overrides
    };
}

describe("a project that serves itself", () => {
    const file = generateDockerfile(plan());

    it("builds on the image it was given", () => {
        expect(file).toContain("FROM node:22-slim");
    });

    it("runs install and build as one layer", () => {
        expect(file).toContain("RUN npm ci && npm run build");
    });

    it("starts through a shell, so a command with its own arguments survives", () => {
        expect(file).toContain('CMD ["sh", "-c", "npm run start"]');
    });

    it("tells the app which port to listen on, and opens it", () => {
        // Everything built from source reads PORT; without it a framework picks its
        // own default and the deployment publishes a port nothing is behind.
        expect(file).toContain("ENV PORT=3000");
        expect(file).toContain("EXPOSE 3000");
    });

    it("says in the file that Polaris wrote it", () => {
        expect(file).toContain("# Written by Polaris");
    });

    it("ends with exactly one newline", () => {
        expect(file.endsWith("\n")).toBe(true);
        expect(file.endsWith("\n\n")).toBe(false);
    });
});

describe("the package manager has to exist before it is used", () => {
    it("turns corepack on for pnpm", () => {
        // The Node images ship corepack disabled, so pnpm's first invocation is
        // "not found" - which reads as a broken image rather than a disabled shim.
        const file = generateDockerfile(plan({ install: "pnpm install --frozen-lockfile", build: "pnpm run build" }));
        expect(file).toContain("RUN corepack enable pnpm && pnpm install --frozen-lockfile && pnpm run build");
    });

    it("turns corepack on for yarn", () => {
        expect(generateDockerfile(plan({ install: "yarn install --frozen-lockfile" }))).toContain("corepack enable yarn");
    });

    it("leaves npm alone, since the image already has it", () => {
        expect(generateDockerfile(plan())).not.toContain("corepack");
    });

    it("leaves bun alone, since bun is its own runtime", () => {
        const file = generateDockerfile(plan({ buildImage: "oven/bun:1", runtimeImage: "oven/bun:1", install: "bun install" }));
        expect(file).not.toContain("corepack");
        expect(file).toContain("FROM oven/bun:1");
    });
});

describe("a monorepo", () => {
    const file = generateDockerfile(
        plan({
            appDirectory: "apps/web",
            workspaceInstall: "pnpm install --frozen-lockfile",
            install: null,
            build: "pnpm run build",
            start: "pnpm run start"
        })
    );

    it("installs once at the repository root, where the lockfile is", () => {
        expect(file).toContain("WORKDIR /workspace");
        expect(file).toContain("RUN corepack enable pnpm && pnpm install --frozen-lockfile");
    });

    it("then works inside the app, so its scripts run where they live", () => {
        expect(file).toContain("WORKDIR /workspace/apps/web");
        // No --filter and no cd: the working directory is the scoping.
        expect(file).not.toContain("--filter");
        expect(file).not.toContain("cd apps/web");
    });

    it("keeps the root install in its own layer, so an app-only change reuses it", () => {
        const rootInstall = file.indexOf("RUN corepack enable pnpm && pnpm install");
        const appWorkdir = file.indexOf("WORKDIR /workspace/apps/web");
        expect(rootInstall).toBeGreaterThan(-1);
        expect(rootInstall).toBeLessThan(appWorkdir);
    });
});

describe("a built site is served, not started", () => {
    const file = generateDockerfile(plan({ staticDirectory: "dist", start: null, port: 8080 }));

    it("builds in one stage and serves from another", () => {
        expect(file).toContain("FROM node:22-slim AS builder");
        expect(file).toContain("FROM nginx:alpine");
    });

    it("ships only the built files, leaving the toolchain behind", () => {
        expect(file).toContain("COPY --from=builder /workspace/dist /usr/share/nginx/html");
        expect(file).not.toContain('CMD ["sh"');
    });

    it("falls back to index.html, so a deep link survives a refresh", () => {
        expect(file).toContain("try_files $uri $uri/ /index.html");
    });

    it("listens on the port the deployment publishes", () => {
        expect(file).toContain("listen 8080 default_server;");
        expect(file).toContain("EXPOSE 8080");
    });

    it("takes the output from inside the app directory in a workspace", () => {
        const nested = generateDockerfile(plan({ appDirectory: "apps/site", staticDirectory: "dist", start: null }));
        expect(nested).toContain("COPY --from=builder /workspace/apps/site/dist /usr/share/nginx/html");
    });
});

describe("a project with nothing to run", () => {
    it("writes no CMD rather than an empty one", () => {
        const file = generateDockerfile(plan({ start: null }));
        expect(file).not.toContain("CMD");
    });

    it("writes no build step when there is neither install nor build", () => {
        const file = generateDockerfile(plan({ install: null, build: null }));
        expect(file).not.toContain("RUN ");
    });
});

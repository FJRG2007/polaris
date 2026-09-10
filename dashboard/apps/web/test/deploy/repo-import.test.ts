/**
 * Where a repository's deploy files land on a new service: what the creator typed
 * always wins, the file fills what was left to defaults, and the variables go in
 * as plain values, generated secrets, or a list of what still needs one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { setEnvVar, setEnvVars, update, findUnique } = vi.hoisted(() => ({
    setEnvVar: vi.fn(async () => undefined),
    setEnvVars: vi.fn(async () => 0),
    update: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => ({ edgeConfig: null }))
}));
vi.mock("@polaris/db", () => ({ prisma: { application: { update, findUnique } } }));
vi.mock("@/lib/env-var-service", () => ({ setEnvVar, setEnvVars }));

const { importDeployConfig } = await import("@polaris/deploy");
const { applyImportedAfterCreate, importedCreate } = await import("@/lib/deploy/repo-import");

const render = importDeployConfig({
    "render.yaml": [
        "services:",
        "  - type: web",
        "    rootDir: apps/api",
        "    buildCommand: pnpm build",
        "    startCommand: pnpm start",
        "    healthCheckPath: /healthz",
        "    numInstances: 40",
        "    envVars:",
        "      - key: MODE",
        "        value: production",
        "      - key: TOKEN_SECRET",
        "        generateValue: true",
        "      - key: STRIPE_KEY",
        "        sync: false"
    ].join("\n")
});

beforeEach(() => {
    setEnvVar.mockClear();
    setEnvVars.mockClear();
    update.mockClear();
});

describe("at creation", () => {
    it("fills the commands, the root directory and the copies, capped", () => {
        const created = importedCreate(render, { builder: "nixpacks" });
        expect(created.rootDirectory).toBe("apps/api");
        expect(created.buildConfig).toEqual({
            languageImages: true,
            buildCommand: "pnpm build",
            startCommand: "pnpm start"
        });
        expect(created.replicas).toBe(10);
    });

    it("never overrides a root directory the creator typed", () => {
        expect(importedCreate(render, { builder: "nixpacks", rootDirectory: "services/web" }).rootDirectory).toBeUndefined();
    });

    it("builds a new service on its language's image even with no deploy files", () => {
        expect(importedCreate(null, { builder: "nixpacks" }).buildConfig).toEqual({ languageImages: true });
        expect(importedCreate(null, { builder: "dockerfile" }).buildConfig).toEqual({});
    });

    it("only puts a Dockerfile path onto a Dockerfile build left at the default", () => {
        const withDockerfile = importDeployConfig({
            "railway.json": JSON.stringify({ build: { builder: "DOCKERFILE", dockerfilePath: "ops/Dockerfile" } })
        });
        expect(importedCreate(withDockerfile, { builder: "dockerfile", dockerfilePath: "Dockerfile" }).dockerfilePath).toBe("ops/Dockerfile");
        expect(importedCreate(withDockerfile, { builder: "dockerfile", dockerfilePath: "docker/Custom" }).dockerfilePath).toBeUndefined();
        expect(importedCreate(withDockerfile, { builder: "nixpacks" }).dockerfilePath).toBeUndefined();
    });
});

describe("after creation", () => {
    it("sets plain variables, generates secrets, keeps the health path and answers what is still needed", async () => {
        const needs = await applyImportedAfterCreate("app-1", "owner-1", render);
        expect(setEnvVars).toHaveBeenCalledWith("application", "app-1", "owner-1", [{ key: "MODE", value: "production", isSecret: false }]);
        expect(setEnvVar).toHaveBeenCalledWith(
            "application",
            "app-1",
            "owner-1",
            expect.objectContaining({ key: "TOKEN_SECRET", isSecret: true, value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })
        );
        const written = JSON.parse((update.mock.calls[0] as unknown as [{ data: { edgeConfig: string } }])[0].data.edgeConfig);
        expect(written.balancing).toEqual({ sticky: false, healthPath: "/healthz" });
        expect(needs).toEqual(["STRIPE_KEY"]);
    });

    it("does nothing without a config", async () => {
        expect(await applyImportedAfterCreate("app-1", "owner-1", null)).toEqual([]);
        expect(setEnvVars).not.toHaveBeenCalled();
    });
});

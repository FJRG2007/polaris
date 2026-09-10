/**
 * A failed deploy's likely cause read from its log file, and each fix changing
 * exactly the setting it names before deploying again.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { state, db, deployApplication, setApplicationPort, setEnvVar } = vi.hoisted(() => {
    const state = { logPath: "", app: {} as Record<string, unknown>, status: "failed" };
    return {
        state,
        db: {
            deployment: {
                findUnique: vi.fn(async () => ({
                    id: "dep-1",
                    status: state.status,
                    error: "build failed",
                    deployableType: "application",
                    deployableId: "app-1"
                }))
            },
            application: {
                findFirst: vi.fn(async () => state.app),
                update: vi.fn(async () => ({}))
            }
        },
        deployApplication: vi.fn(async () => "dep-2"),
        setApplicationPort: vi.fn(async () => undefined),
        setEnvVar: vi.fn(async () => undefined)
    };
});
vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/env-var-service", () => ({ setEnvVar }));
vi.mock("@/lib/deploy/log-file", () => ({ deployLogPath: () => state.logPath }));
vi.mock("@/lib/deploy-service", () => ({
    containerPortOf: () => 3000,
    deployApplication,
    setApplicationPort
}));

const { applyDeployFix, diagnoseDeployment } = await import("@/lib/deploy/diagnosis");
const { deployFixInputSchema } = await import("@polaris/core");

let dir = "";
beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "polaris-fix-"));
    state.logPath = join(dir, "dep-1.log");
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
    state.status = "failed";
    state.app = {
        id: "app-1",
        sourceType: "nixpacks",
        sourceConfig: JSON.stringify({ repoUrl: "https://github.com/acme/web", rootDirectory: "apps/web" }),
        buildConfig: JSON.stringify({ installCommand: "pnpm install" }),
        domains: []
    };
    db.application.update.mockClear();
    setEnvVar.mockClear();
    deployApplication.mockClear();
});

/** What was written to the service, parsed. */
function written(): { sourceType?: string; source: Record<string, unknown>; build: Record<string, unknown> } {
    const data = (db.application.update.mock.calls.at(-1) as unknown as [{ data: Record<string, string> }])[0].data;
    return { sourceType: data.sourceType, source: JSON.parse(data.sourceConfig ?? "{}"), build: JSON.parse(data.buildConfig ?? "{}") };
}

describe("reading the cause", () => {
    it("reads it from the end of the deploy's own log", async () => {
        await writeFile(state.logPath, `${"noise\n".repeat(20_000)}npm error Missing script: "start"\n`, "utf8");
        const found = await diagnoseDeployment("dep-1", "owner-1");
        expect(found?.cause).toBe("missing-start-script");
    });

    it("offers nothing for a deploy that did not fail", async () => {
        state.status = "running";
        expect(await diagnoseDeployment("dep-1", "owner-1")).toBeNull();
    });
});

describe("applying a fix", () => {
    it("sets the start command, keeps everything else, and deploys again", async () => {
        const next = await applyDeployFix("dep-1", "owner-1", "user-1", { kind: "set-start-command", value: "node server.js" });
        expect(next).toBe("dep-2");
        expect(written().build).toEqual({ installCommand: "pnpm install", startCommand: "node server.js" });
        expect(written().source.rootDirectory).toBe("apps/web");
        expect(deployApplication).toHaveBeenCalledWith("app-1", "owner-1", "user-1");
    });

    it("clears a build command set to nothing", async () => {
        state.app = { ...state.app, buildConfig: JSON.stringify({ buildCommand: "npm run build" }) };
        await applyDeployFix("dep-1", "owner-1", "user-1", { kind: "set-build-command", value: "" });
        expect(written().build).toEqual({});
    });

    it("names the runtime version, which moves the service onto the generated image", async () => {
        await applyDeployFix("dep-1", "owner-1", "user-1", { kind: "set-runtime-version", version: "20" });
        expect(written().build.runtimeVersion).toBe("20");
    });

    it("generates Laravel's key in the shape Laravel reads, as a secret", async () => {
        await applyDeployFix("dep-1", "owner-1", "user-1", { kind: "add-variable", name: "APP_KEY", value: null, generate: true });
        expect(setEnvVar).toHaveBeenCalledWith(
            "application",
            "app-1",
            "owner-1",
            expect.objectContaining({ key: "APP_KEY", isSecret: true, value: expect.stringMatching(/^base64:[A-Za-z0-9+/]{43}=$/) })
        );
    });

    it("keeps a typed credential secret and a typed setting plain", async () => {
        await applyDeployFix("dep-1", "owner-1", "user-1", { kind: "add-variable", name: "STRIPE_KEY", value: "sk_test_x", generate: false });
        expect(setEnvVar).toHaveBeenLastCalledWith("application", "app-1", "owner-1", { key: "STRIPE_KEY", value: "sk_test_x", isSecret: true });
        await applyDeployFix("dep-1", "owner-1", "user-1", { kind: "add-variable", name: "HOST", value: "0.0.0.0", generate: false });
        expect(setEnvVar).toHaveBeenLastCalledWith("application", "app-1", "owner-1", { key: "HOST", value: "0.0.0.0", isSecret: false });
    });

    it("moves a Dockerfile service with no Dockerfile onto the detected build", async () => {
        state.app = { ...state.app, sourceType: "dockerfile", sourceConfig: JSON.stringify({ repoUrl: "x", dockerfilePath: "Dockerfile" }) };
        await applyDeployFix("dep-1", "owner-1", "user-1", { kind: "use-detected-build" });
        expect(written().sourceType).toBe("nixpacks");
        expect(written().source.dockerfilePath).toBeUndefined();
        expect(written().build.languageImages).toBe(true);
    });

    it("refuses a deploy that did not fail", async () => {
        state.status = "running";
        await expect(applyDeployFix("dep-1", "owner-1", "user-1", { kind: "set-port", port: 8080 })).rejects.toThrow();
        expect(deployApplication).not.toHaveBeenCalled();
    });
});

describe("what the screen may send", () => {
    it("refuses a command across lines, an empty start command and a variable with no value to set", () => {
        expect(deployFixInputSchema.safeParse({ kind: "set-start-command", value: "a\nrm -rf /" }).success).toBe(false);
        expect(deployFixInputSchema.safeParse({ kind: "set-start-command", value: "  " }).success).toBe(false);
        expect(deployFixInputSchema.safeParse({ kind: "add-variable", name: "X", value: null, generate: false }).success).toBe(false);
        expect(deployFixInputSchema.safeParse({ kind: "add-variable", name: "1X", value: "a", generate: false }).success).toBe(false);
        expect(deployFixInputSchema.safeParse({ kind: "set-runtime-version", version: "latest" }).success).toBe(false);
        expect(deployFixInputSchema.safeParse({ kind: "set-port", port: 8080 }).success).toBe(true);
    });
});

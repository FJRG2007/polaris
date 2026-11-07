/**
 * The services Polaris runs for one of its apps, as that app's settings reach them.
 *
 * Two traps. The settings of one app must not reach another app's service, or a
 * service somebody deployed, by naming its id. And the log and restart must run
 * as the project's owner: Deploy's own log route answers only the project's
 * people, so a second administrator would see nothing from it.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
    restarted: [] as Array<[string, string]>,
    logs: [] as Array<[string, string, number]>
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async () => [
                { id: "i-vpn", name: "VPN control server", catalogId: "vpn-engine", applicationId: "vpn-app" },
                { id: "i-mc", name: "Survival", catalogId: "minecraft", applicationId: "mc-app" }
            ]
        },
        mailServer: { findMany: async () => [{ applicationId: "mail-app" }] },
        application: {
            findUnique: async ({ where }: { where: { id: string } }) => ({
                environment: { project: { ownerId: `owner-of-${where.id}` } }
            }),
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({ id, name: `${id}-service`, currentDeploymentId: null }))
        }
    }
}));
vi.mock("@/lib/deploy-service", () => ({
    restartApplication: async (id: string, ownerId: string) => void calls.restarted.push([id, ownerId]),
    readAppRuntimeLog: async (id: string, ownerId: string, tail: number) => {
        calls.logs.push([id, ownerId, tail]);
        return "ready\n";
    },
    getApplicationDeployStatuses: async (apps: Array<{ id: string }>) =>
        Object.fromEntries(apps.map((app) => [app.id, "running"]))
}));
vi.mock("@/lib/consumption-service", () => ({
    readConsumption: async () => {
        throw new Error("engine unreachable");
    }
}));

const services = await import("@/lib/apps/app-services");

beforeEach(() => {
    calls.restarted = [];
    calls.logs = [];
});

describe("an app's services", () => {
    it("are the ones backing its installs, a game server under Game servers", async () => {
        const list = await services.listAppServices("game-servers", "admin");
        expect(list.map((one) => one.applicationId)).toEqual(["mc-app"]);
        expect(list[0]?.installName).toBe("Survival");
        expect(list[0]?.status).toBe("running");
    });

    it("still list with their state when the engine's figures cannot be read", async () => {
        const [vpn] = await services.listAppServices("vpn", "admin");
        expect(vpn?.applicationId).toBe("vpn-app");
        expect(vpn?.cpuPercent).toBeNull();
        expect(vpn?.memUsedBytes).toBeNull();
    });

    it("include the mail server's for the mail server app", async () => {
        const list = await services.listAppServices("mail-server", "admin");
        expect(list.map((one) => one.applicationId)).toEqual(["mail-app"]);
    });

    it("decide whether the app has settings to show them in", async () => {
        expect(await services.appHasServices("vpn")).toBe(true);
        expect(await services.appHasServices("notes")).toBe(false);
    });
});

describe("restarting and reading one", () => {
    it("runs as the project's owner, whoever the administrator is", async () => {
        expect(await services.restartAppService("vpn", "vpn-app")).toBe(true);
        expect(calls.restarted).toEqual([["vpn-app", "owner-of-vpn-app"]]);

        expect(await services.readAppServiceLog("vpn", "vpn-app", 500)).toBe("ready\n");
        expect(calls.logs).toEqual([["vpn-app", "owner-of-vpn-app", 500]]);
    });

    it("refuses a service that is not this app's, or that nobody installed", async () => {
        expect(await services.restartAppService("vpn", "mc-app")).toBe(false);
        expect(await services.restartAppService("vpn", "somebodys-site")).toBe(false);
        expect(await services.readAppServiceLog("game-servers", "vpn-app", 500)).toBeNull();
        expect(calls.restarted).toEqual([]);
        expect(calls.logs).toEqual([]);
    });
});

describe("what this change may do to a running service", () => {
    // The operator's rule for moving these services out of Deploy: nothing that
    // runs them is stopped, recreated, relabelled or removed. The only runtime call
    // these files make is the in-place restart Deploy always offered.
    const files = [
        "src/lib/apps/app-services.ts",
        "src/lib/deploy/managed-projects.ts",
        "src/app/(app)/admin/apps/[appId]/settings/service-actions.ts",
        "src/app/(app)/admin/apps/[appId]/settings/app-services-panel.tsx",
        "src/app/(app)/apps/deploy/[projectId]/polaris-redirect.ts"
    ];

    it("calls nothing that stops, removes, recreates or writes", async () => {
        const forbidden =
            /\b(stop|remove|delete|prune|recreate|redeploy|uninstall|kill)[A-Z]\w*\(|\.(create|update|upsert|delete|deleteMany|updateMany)\(/;
        for (const file of files) {
            const source = await readFile(join(process.cwd(), file), "utf8");
            expect(source, file).not.toMatch(forbidden);
        }
    });
});

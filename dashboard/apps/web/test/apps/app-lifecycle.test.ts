/**
 * Uninstalling and reinstalling a first-party app.
 *
 * Nothing anybody made is deleted. Game servers is refused while servers exist,
 * so a world is never lost by uninstalling; Places brings its helper containers
 * down and back up with it; and an instance that has only game servers, or only
 * the old per-game managers, still counts as having Game servers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Install = {
    id: string;
    ownerId: string;
    catalogId: string;
    name: string;
    status: string;
    applicationId: string | null;
    config: string;
    createdAt: Date;
};
let installs: Install[] = [];
const removed: string[] = [];
const deployed: string[] = [];
const stopped = new Set<string>();
const failing = new Set<string>();

function matches(row: Install, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        const field = (row as Record<string, unknown>)[key];
        if (value && typeof value === "object") {
            const rule = value as { in?: unknown[]; not?: unknown };
            if (rule.in) return rule.in.includes(field);
            if ("not" in rule) return field !== rule.not;
        }
        return field === value;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                installs.filter((row) => matches(row, where)),
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                installs.find((row) => matches(row, where)) ?? null
        },
        application: {
            findFirst: async ({ where }: { where: { id: string } }) => ({
                desiredState: stopped.has(where.id) ? "stopped" : "running"
            })
        },
        mailServer: { findFirst: async () => null }
    }
}));

vi.mock("@/lib/deploy-service", () => ({
    removeApplicationDeployment: async (applicationId: string) => {
        if (failing.has(applicationId)) throw new Error("daemon unavailable");
        removed.push(applicationId);
    },
    deployApplication: async (applicationId: string) => {
        if (failing.has(applicationId)) throw new Error("daemon unavailable");
        deployed.push(applicationId);
    }
}));

vi.mock("@/lib/apps/install-config", () => ({
    readInstallConfig: (raw: string | null) => (raw ? JSON.parse(raw) : {}),
    patchInstallConfig: async (id: string, patch: Record<string, unknown>) => {
        installs = installs.map((row) =>
            row.id === id
                ? { ...row, config: JSON.stringify({ ...JSON.parse(row.config), ...patch }) }
                : row
        );
    }
}));

const { appUninstallRefusal, pauseOwnedServices, resumeOwnedServices } = await import(
    "@/lib/apps/app-lifecycle"
);
const { isAppInstalled, invalidateInstallPresence } = await import("@/lib/apps/install-presence");

const OWNER = "owner-1";

function install(overrides: Partial<Install>): Install {
    return {
        id: `install-${installs.length + 1}`,
        ownerId: OWNER,
        catalogId: "game-servers",
        name: "Game servers",
        status: "running",
        applicationId: null,
        config: "{}",
        createdAt: new Date(installs.length * 1000),
        ...overrides
    };
}

beforeEach(() => {
    installs = [];
    removed.length = 0;
    deployed.length = 0;
    stopped.clear();
    failing.clear();
    invalidateInstallPresence();
});

describe("uninstalling Game servers", () => {
    it("is refused while the owner still has servers, naming them", async () => {
        installs.push(install({ name: "Survival", catalogId: "minecraft" }));
        installs.push(install({ name: "Old world", catalogId: "minecraft", status: "removed" }));
        const refusal = await appUninstallRefusal({ catalogId: "game-servers", ownerId: OWNER });
        expect(refusal).toContain("Survival");
        expect(refusal).not.toContain("Old world");
    });

    it("goes ahead once there are none, and never touches a server", async () => {
        expect(await appUninstallRefusal({ catalogId: "game-servers", ownerId: OWNER })).toBeNull();
        installs.push(install({ catalogId: "minecraft", applicationId: "app-mc" }));
        await pauseOwnedServices("game-servers");
        expect(removed).toEqual([]);
    });

    it("is not asked of other apps", async () => {
        installs.push(install({ catalogId: "minecraft" }));
        expect(await appUninstallRefusal({ catalogId: "home", ownerId: OWNER })).toBeNull();
    });
});

describe("Places' helper containers", () => {
    it("come down with the app and back up with it, and only the ones it paused", async () => {
        installs.push(install({ catalogId: "camera-hub", applicationId: "app-relay" }));
        installs.push(install({ catalogId: "vision-worker", applicationId: "app-vision" }));
        await pauseOwnedServices("home");
        expect(removed.sort()).toEqual(["app-relay", "app-vision"]);

        installs.push(install({ catalogId: "face-recognizer", applicationId: "app-face" }));
        await resumeOwnedServices("home", OWNER);
        expect(deployed.sort()).toEqual(["app-relay", "app-vision"]);

        deployed.length = 0;
        await resumeOwnedServices("home", OWNER);
        expect(deployed).toEqual([]);
    });

    it("leave a helper the operator had switched off switched off", async () => {
        installs.push(install({ catalogId: "camera-hub", applicationId: "app-relay" }));
        installs.push(install({ catalogId: "face-recognizer", applicationId: "app-face" }));
        stopped.add("app-face");
        await pauseOwnedServices("home");
        expect(removed.sort()).toEqual(["app-face", "app-relay"]);

        await resumeOwnedServices("home", OWNER);
        expect(deployed).toEqual(["app-relay"]);
    });

    it("keep a helper that failed to come back marked for the next try", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        installs.push(install({ catalogId: "camera-hub", applicationId: "app-relay" }));
        await pauseOwnedServices("home");

        failing.add("app-relay");
        await resumeOwnedServices("home", OWNER);
        expect(deployed).toEqual([]);
        expect(error).toHaveBeenCalled();

        failing.clear();
        await resumeOwnedServices("home", OWNER);
        expect(deployed).toEqual(["app-relay"]);
        error.mockRestore();
    });

    it("are not marked paused when they could not be brought down", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        installs.push(install({ catalogId: "camera-hub", applicationId: "app-relay" }));
        failing.add("app-relay");
        await pauseOwnedServices("home");
        expect(error).toHaveBeenCalled();

        failing.clear();
        await resumeOwnedServices("home", OWNER);
        expect(deployed).toEqual([]);
        error.mockRestore();
    });
});

describe("whether Game servers is installed", () => {
    it("counts an instance that only has servers, or only an old manager", async () => {
        expect(await isAppInstalled("game-servers")).toBe(false);

        installs.push(install({ catalogId: "minecraft" }));
        invalidateInstallPresence();
        expect(await isAppInstalled("game-servers")).toBe(true);

        installs = [install({ catalogId: "minecraft-manager" })];
        invalidateInstallPresence();
        expect(await isAppInstalled("game-servers")).toBe(true);

        installs = [install({ catalogId: "minecraft", status: "removed" })];
        invalidateInstallPresence();
        expect(await isAppInstalled("game-servers")).toBe(false);
    });
});

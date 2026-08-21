/**
 * Keeping Home's own containers from falling a version behind for good.
 *
 * This is the failure it exists for, and it is worth writing down because it is
 * invisible: the vision worker sat on a four-day-old image for as long as the
 * feature existed, logging every thirty seconds that it was watching a camera,
 * while the code that would have made it work had been published and pulled by
 * nobody. Nothing upgrades these - the update button updates Polaris, and a
 * marketplace app is upgraded by whoever installed it, which for these is
 * nobody.
 *
 * The rules that make the fix safe are all here: it happens once per build and
 * not once per restart, it never starts something somebody switched off, and a
 * failure is retried rather than recorded as done.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let build = "abc123";
let settings: Record<string, string> = {};
/** What is installed, and whether each is meant to be up. */
let installs: { applicationId: string; ownerId: string; catalogId: string }[] = [];
let states: Record<string, string> = {};

const deployApplication = vi.fn(async () => undefined);

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_BUILD_SHA: build }) }));
vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findMany: vi.fn(async () => installs) },
        application: {
            findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
                desiredState: states[where.id] ?? "running"
            }))
        }
    }
}));
vi.mock("@/lib/deploy-service", () => ({ deployApplication }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async (key: string) => settings[key] ?? null),
    setSetting: vi.fn(async (key: string, value: string | null) => {
        if (value === null) delete settings[key];
        else settings[key] = value;
    })
}));

const { upgradeHomeServices } = await import("@/lib/home/side-upgrade");

beforeEach(() => {
    build = "abc123";
    settings = {};
    states = {};
    installs = [
        { applicationId: "relay-app", ownerId: "owner-1", catalogId: "camera-relay" },
        { applicationId: "vision-app", ownerId: "owner-1", catalogId: "vision-worker" }
    ];
    deployApplication.mockClear();
    deployApplication.mockImplementation(async () => undefined);
});

describe("bringing them to this build", () => {
    it("redeploys each one, which is what pulls the new image", async () => {
        await upgradeHomeServices();
        expect(deployApplication).toHaveBeenCalledTimes(2);
        expect(deployApplication).toHaveBeenCalledWith("vision-app", "owner-1", "owner-1");
    });

    it("does it once per build and not once per restart", async () => {
        await upgradeHomeServices();
        deployApplication.mockClear();
        await upgradeHomeServices();
        expect(deployApplication).not.toHaveBeenCalled();
    });

    it("does it again when Polaris itself has been updated", async () => {
        await upgradeHomeServices();
        deployApplication.mockClear();
        build = "def456";
        await upgradeHomeServices();
        expect(deployApplication).toHaveBeenCalledTimes(2);
    });

    it("leaves something switched off switched off", async () => {
        // A recognizer that is stopped is stopped because somebody wanted the
        // memory back. Starting it to upgrade it is the worst possible reading
        // of that switch.
        installs.push({ applicationId: "face-app", ownerId: "owner-1", catalogId: "face-recognizer" });
        states["face-app"] = "stopped";
        await upgradeHomeServices();
        expect(deployApplication).not.toHaveBeenCalledWith("face-app", "owner-1", "owner-1");
        expect(deployApplication).toHaveBeenCalledTimes(2);
    });

    it("tries again next time when one of them would not come up", async () => {
        deployApplication.mockImplementation(async (id: string) => {
            if (id === "vision-app") throw new Error("registry unreachable");
        });
        await upgradeHomeServices();
        // Recording the build here would leave this deployment on the old image
        // until the next Polaris release, which is the failure this file is about.
        expect(settings["home.services.build"]).toBeUndefined();
    });

    it("does nothing at all on a development run", async () => {
        // Nothing to be behind, and redeploying on every restart would be its
        // own bug.
        build = "";
        await upgradeHomeServices();
        expect(deployApplication).not.toHaveBeenCalled();
    });

    it("records the build for a house that runs none of them", async () => {
        installs = [];
        await upgradeHomeServices();
        expect(settings["home.services.build"]).toBe("abc123");
    });
});

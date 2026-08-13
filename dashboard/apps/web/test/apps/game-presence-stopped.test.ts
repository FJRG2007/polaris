/**
 * What a reading says about a server nobody can be asked about.
 *
 * A server that is not running is never knocked on, so its row is written from the
 * facts alone - and the one field that matters there is whether the container is
 * known to be down. Everything downstream reads that: the uptime run is closed on
 * it, the open visits are closed on it, and both of them are wrong forever if a
 * deliberate stop is filed as "could not tell". A server that has never been
 * deployed is the case that genuinely cannot be told, and it is the only one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";
const APPLICATION = "bbbbbbbb-1111-4111-8111-111111111111";
const HOST = "cccccccc-1111-4111-8111-111111111111";

/** The install row the reading is built from, and what its application was last
 *  told to do. */
let install: {
    id: string;
    name: string;
    catalogId: string;
    applicationId: string | null;
    targetId: string | null;
    config: string | null;
    status: string;
    createdAt: Date;
};
let desiredState: string;

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findMany: async () => [install] },
        deployTarget: { findMany: async () => [{ id: "target", name: "This machine" }] },
        application: {
            findMany: async () =>
                install.applicationId
                    ? [
                          {
                              id: install.applicationId,
                              sourceConfig: null,
                              desiredState,
                              currentDeploymentId: null,
                              target: { kind: "remote", hostId: HOST }
                          }
                      ]
                    : []
        },
        deployment: { findMany: async () => [] },
        host: { findMany: async () => [{ id: HOST, address: "10.0.0.5" }] },
        envVar: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/apps/minecraft/service", () => ({
    getServerPlayers: async () => {
        throw new Error("a server that is not running must not be knocked on");
    },
    applyFirewallBans: async () => undefined,
    editionOf: () => "java"
}));

vi.mock("@/lib/apps/ark/service", () => ({
    getArkPlayers: async () => {
        throw new Error("a server that is not running must not be knocked on");
    },
    applyAllowList: async () => undefined
}));

const { listGameServerPresence } = await import("@/lib/apps/games-service");

beforeEach(() => {
    install = {
        id: INSTALL,
        name: "Survival",
        catalogId: "minecraft",
        applicationId: APPLICATION,
        targetId: "target",
        config: null,
        status: "installed",
        createdAt: new Date("2026-08-01T00:00:00.000Z")
    };
    desiredState = "stopped";
});

describe("reading a server that is not running", () => {
    it("reports a server that was stopped on purpose as a container that is down", async () => {
        // The stop is the answer. Filed as "could not tell", the run it was on
        // would never be closed and it would still be reported as up since March.
        const [presence] = await listGameServerPresence(OWNER);
        expect(presence.answering).toBe(false);
        expect(presence.containerRunning).toBe(false);
        expect(presence.online).toBe(0);
    });

    it("says nothing about a container for a server that has never been deployed", async () => {
        install = { ...install, applicationId: null };
        const [presence] = await listGameServerPresence(OWNER);
        expect(presence.answering).toBe(false);
        expect(presence.containerRunning).toBeNull();
    });
});

/**
 * A scan on this machine goes through the host daemon. A Polaris without one
 * (the limited edition) is told so for good; a daemon that is only down for now
 * is a scan to try again, and the hourly export sweep leaves a missing daemon
 * alone instead of dialling it.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const daemon = vi.hoisted(() => ({
    healthy: false,
    configured: false,
    listed: 0
}));

vi.mock("@polaris/hostd-client", async (original) => {
    const actual = await original<typeof import("@polaris/hostd-client")>();
    return {
        ...actual,
        HostdClient: class {
            async health() {
                return daemon.healthy ? {} : null;
            }
            async configured() {
                return daemon.configured;
            }
            async hostImageExports() {
                daemon.listed++;
                return [];
            }
            async hostSecurity() {
                return { exitCode: 0, output: "" };
            }
        },
        RealHostdClient: actual.HostdClient
    };
});
vi.mock("@polaris/config", async (original) => ({
    ...(await original<typeof import("@polaris/config")>()),
    loadEnv: () => ({
        POLARIS_HOSTD_SOCKET: "/run/polaris/hostd.sock",
        POLARIS_HOSTD_TOKEN_FILE: "/run/polaris/hostd.token"
    })
}));
vi.mock("@polaris/app-host", () => ({ host: {} }));
vi.mock("@polaris/ssh", () => ({ openSshClient: vi.fn(), execCommand: vi.fn() }));

const runner = await import("@polaris-app/security-scans/src/lib/runner");

const local = {
    id: "local",
    ownerId: "owner",
    kind: "local",
    hostId: null,
    runtime: "docker",
    proxyNetwork: "polaris_default"
};
const action = { action: "audit" } as unknown as Parameters<typeof runner.runHostAction>[1];

async function failure(): Promise<string | null> {
    try {
        await runner.runHostAction(local, action);
        return null;
    } catch (caught) {
        return caught instanceof runner.ScanFailure ? caught.code : "other";
    }
}

describe("security scans on this machine", () => {
    beforeEach(() => {
        daemon.healthy = false;
        daemon.configured = false;
        daemon.listed = 0;
    });

    it("says there is no host service when this Polaris has none", async () => {
        expect(await failure()).toBe("noDaemon");
    });

    it("asks to try again when the host service is only down", async () => {
        daemon.configured = true;
        expect(await failure()).toBe("lost");
    });

    it("runs when the host service answers", async () => {
        daemon.healthy = true;
        daemon.configured = true;
        expect(await failure()).toBeNull();
    });

    it("does not sweep exports on a Polaris with no host service", async () => {
        expect(await runner.listExports(local)).toBeNull();
        expect(daemon.listed).toBe(0);
        daemon.configured = true;
        expect(await runner.listExports(local)).toEqual([]);
        expect(daemon.listed).toBe(1);
    });
});

describe("HostdClient.configured", async () => {
    const { RealHostdClient } = (await import("@polaris/hostd-client")) as unknown as {
        RealHostdClient: typeof import("@polaris/hostd-client").HostdClient;
    };
    const dir = mkdtempSync(join(tmpdir(), "polaris-hostd-"));

    it("is false with no token file and no TCP address", async () => {
        const client = new RealHostdClient({ tokenFile: join(dir, "absent.token") });
        expect(await client.configured()).toBe(false);
    });

    it("is true once the daemon has written its token", async () => {
        const tokenFile = join(dir, "hostd.token");
        writeFileSync(tokenFile, "token");
        expect(await new RealHostdClient({ tokenFile }).configured()).toBe(true);
    });

    it("is true with a TCP address", async () => {
        const client = new RealHostdClient({
            tcpUrl: "http://127.0.0.1:1",
            tokenFile: join(dir, "absent.token")
        });
        expect(await client.configured()).toBe(true);
    });
});

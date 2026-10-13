/**
 * Removing an app's volume on a server reached over SSH: one quoted command, and
 * only for a name in the shape Polaris gives an app's volumes. The connection is
 * a fake - nothing is run on a machine here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const commands: string[] = [];
let exitCode = 0;
vi.mock("@polaris/ssh", async (load) => ({
    ...(await load<object>()),
    openSshClient: async () => ({ end: () => undefined }),
    execCommand: async (_client: unknown, command: string) => {
        commands.push(command);
        return { code: exitCode, stdout: "", stderr: "" };
    }
}));

const { SshPorts } = await import("@/lib/deploy/ports-ssh");

function ports() {
    return new SshPorts({
        address: "server.example.test",
        port: 22,
        username: "polaris",
        auth: { kind: "password", password: "fixture" } as never,
        hostKey: null as never,
        hostId: "host-1"
    });
}

beforeEach(() => {
    commands.length = 0;
    exitCode = 0;
});

describe("SshPorts.removeVolume", () => {
    it("removes the named volume, quoted and never forced", async () => {
        await ports().removeVolume("polaris-1a2b3c4d_data");
        expect(commands).toEqual(["docker volume rm polaris-1a2b3c4d_data"]);
    });

    it("refuses a name that is not an app's volume before anything runs", async () => {
        for (const name of [
            "postgres_data",
            "polaris-1a2b3c4d_",
            "polaris-1a2b3c4d_data; rm -rf /",
            "polaris-1a2b3c4d_$(id)",
            "-f polaris-1a2b3c4d_data"
        ]) {
            await expect(ports().removeVolume(name), name).rejects.toThrow();
        }
        expect(commands).toEqual([]);
    });

    it("fails when the server refuses, so the caller can say it was left", async () => {
        exitCode = 1;
        await expect(ports().removeVolume("polaris-1a2b3c4d_data")).rejects.toThrow();
    });
});

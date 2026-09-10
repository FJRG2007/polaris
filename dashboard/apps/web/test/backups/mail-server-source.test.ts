/**
 * A mail server's copy is its engine's own export, taken with the engine stopped:
 * the export runs in a one-off container on the engine's own volumes, the engine
 * is started again whatever happened, and a failed export says what it printed.
 */

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

const SERVER = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const APP = "019f8506-683f-7dd0-9c13-1e9ee9237fe4";

const { calls, ports, exitCode } = vi.hoisted(() => {
    const calls: string[] = [];
    const exitCode = { value: 0 };
    const ports = {
        inspect: vi.fn(async (ref: string) =>
            ref === "mail-engine"
                ? {
                      Config: { Image: "stalwartlabs/stalwart:v0.16" },
                      Mounts: [
                          {
                              Type: "volume",
                              Name: "polaris-abc_stalwart-config",
                              Destination: "/etc/stalwart"
                          },
                          {
                              Type: "volume",
                              Name: "polaris-abc_stalwart-data",
                              Destination: "/var/lib/stalwart"
                          }
                      ]
                  }
                : { State: { Status: "exited", ExitCode: exitCode.value } }
        ),
        runIn: vi.fn(async (_container: string, argv: readonly string[]) => {
            calls.push(`runIn ${argv.join(" ").slice(0, 40)}`);
            return { code: 0, output: "" };
        }),
        container: vi.fn(
            async (ref: string, action: string) => void calls.push(`${action} ${ref}`)
        ),
        composeUp: vi.fn(
            async (spec: { project: string }) => void calls.push(`up ${spec.project}`)
        ),
        composeDown: vi.fn(async (project: string) => void calls.push(`down ${project}`)),
        logs: vi.fn(async (_ref: string, onData: (chunk: Buffer) => void) =>
            onData(Buffer.from("store is locked"))
        ),
        readFile: vi.fn(
            async () =>
                Readable.toWeb(
                    Readable.from([Buffer.from("tar bytes")])
                ) as ReadableStream<Uint8Array>
        ),
        dispose: vi.fn(async () => undefined)
    };
    return { calls, ports, exitCode };
});

vi.mock("@polaris/db", () => ({
    prisma: {
        mailServer: {
            findUnique: async () => ({
                id: SERVER,
                hostname: "mail.example.com",
                applicationId: APP
            })
        },
        application: {
            findUnique: async () => ({
                id: APP,
                currentDeploymentId: "dep",
                target: { kind: "local" },
                environment: { project: { ownerId: "owner", slug: "p" } }
            })
        }
    }
}));
vi.mock("@/lib/deploy/releases", () => ({
    currentReleaseRef: async () => ({ name: "mail-engine" })
}));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: async () => ports }));

const source = await import("@/lib/backups/sources/mail-server");

const resource = {
    id: "r1",
    ownerId: "owner",
    kind: "mail-server" as const,
    selector: `mail-server:${SERVER}`,
    name: "Mail mail.example.com",
    config: {}
};

beforeEach(() => {
    calls.length = 0;
    exitCode.value = 0;
});

describe("the mail server's copy", () => {
    it("exports with the engine stopped, on its own volumes, and starts it again", async () => {
        const staged = await source.mailServerSource.produce(resource);
        const stop = calls.indexOf("stop mail-engine");
        const up = calls.findIndex((call) => call.startsWith("up polaris-mailtask-"));
        const start = calls.indexOf("start mail-engine");
        expect(stop).toBeGreaterThan(-1);
        expect(up).toBeGreaterThan(stop);
        expect(start).toBeGreaterThan(up);
        const spec = ports.composeUp.mock.calls[0]?.[0] as ReturnType<
            typeof source.maintenanceSpec
        >;
        expect(spec.externalVolumes).toEqual([
            "polaris-abc_stalwart-config",
            "polaris-abc_stalwart-data"
        ]);
        expect(spec.services[0]?.command).toEqual([
            "--config",
            "/etc/stalwart/config.json",
            "--export",
            "/var/lib/stalwart/.polaris-export"
        ]);
        expect(spec.services[0]?.restart).toBe("no");
        expect(staged.metadata.format).toBe(source.MAIL_EXPORT_FORMAT);
        await staged.cleanup();
    });

    it("starts the engine again when the export fails, and says what it printed", async () => {
        exitCode.value = 1;
        await expect(source.mailServerSource.produce(resource)).rejects.toThrow(/store is locked/);
        expect(calls).toContain("start mail-engine");
    });

    it("refuses to restore something that is not an export", async () => {
        const body = Readable.toWeb(
            Readable.from([Buffer.from("x")])
        ) as ReadableStream<Uint8Array>;
        await expect(
            source.mailServerSource.restore!(resource, body, { format: "tar" }, "actor")
        ).rejects.toThrow(/not an export/);
    });
});

describe("the pieces", () => {
    it("finds a volume by where it is mounted", () => {
        const inspect = {
            Mounts: [
                { Type: "bind", Name: "x", Destination: "/data" },
                { Type: "volume", Name: "v", Destination: "/data" }
            ]
        };
        expect(source.volumeAt(inspect, "/data")).toBe("v");
        expect(source.volumeAt(inspect, "/other")).toBeNull();
        expect(source.volumeAt(null, "/data")).toBeNull();
    });

    it("puts the old store back when the import fails, and drops it when it does not", () => {
        const script = source.restoreScript();
        expect(script).toContain("--import '/var/lib/stalwart/.polaris-import'");
        expect(script).toMatch(/then rm -rf \.polaris-before-restore; exit 0; fi/);
        expect(script).toContain(
            "find .polaris-before-restore -mindepth 1 -maxdepth 1 -exec mv -t . -- {} +"
        );
        expect(script.split("\n").at(-1)).toBe("exit 1");
    });
});

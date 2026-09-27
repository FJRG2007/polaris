/**
 * Several lines sent to a Minecraft server at once (`ServerContainer.sayAll`).
 *
 * On Java they go to the console tool in one exec, read one per line from its
 * input. Each is held to the same checks as a line sent on its own - above all
 * the length the tool drops without a word - and a batch the server never
 * answers fails in bounded time rather than holding whoever sent it forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    edition: "minecraft" as string,
    runs: [] as string[][],
    hang: false,
    code: 0,
    disposed: 0
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => ({
                id: "mc",
                applicationId: "app",
                catalogId: fake.edition,
                config: "{}"
            })
        },
        application: {
            findFirst: async () => ({
                id: "app",
                desiredState: "running",
                sourceConfig: "{}",
                target: { id: "local" }
            })
        }
    }
}));

vi.mock("@polaris/app-host", () => {
    const ports = {
        runIn: (_container: string, argv: string[]) => {
            fake.runs.push(argv);
            return fake.hang
                ? new Promise(() => undefined)
                : Promise.resolve({ code: fake.code, output: "" });
        },
        dispose: async () => {
            fake.disposed += 1;
        },
        readFile: async () => new ReadableStream(),
        trimWorld: null
    };
    const known: Record<string, Record<string, unknown>> = {
        deployRuntime: { getPorts: async () => ports },
        deployReleases: {
            currentReleaseRef: async () => ({ name: "polaris-mc", portSubject: "mc" })
        }
    };
    const stub = (name: string) =>
        new Proxy(known[name] ?? {}, {
            get: (target, key: string) => target[key] ?? (async () => undefined)
        });
    return { host: new Proxy({}, { get: (_target, name: string) => stub(name) }) };
});

const service = await import("@polaris-app/game-servers/src/lib/minecraft/service");

const line = (text: string) => `scoreboard players display name polaris.line.01 polaris ${text}`;

beforeEach(() => {
    fake.edition = "minecraft";
    fake.runs = [];
    fake.hang = false;
    fake.code = 0;
    fake.disposed = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe("sayAll", () => {
    it("sends a Java batch as one exec, one command a line", async () => {
        const { server, close } = await service.openServerContainer("owner", "mc");
        await server.sayAll([line('"a"'), line('"b"')]);
        await close();
        expect(fake.runs).toHaveLength(1);
        const script = fake.runs[0]![2] ?? "";
        const encoded = /^printf %s (\S+) \| base64 -d \| rcon-cli$/.exec(script)?.[1] ?? "";
        expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
            `${line('"a"')}\n${line('"b"')}\n`
        );
        expect(fake.disposed).toBe(1);
    });

    it("refuses a line longer than the console tool takes, and sends nothing", async () => {
        const { server } = await service.openServerContainer("owner", "mc");
        const long = line(`"${"x".repeat(1_100)}"`);
        await expect(server.sayAll([line('"a"'), long])).rejects.toThrow();
        expect(fake.runs).toEqual([]);
    });

    it("refuses a line that would be two commands", async () => {
        const { server } = await service.openServerContainer("owner", "mc");
        await expect(server.sayAll([line('"a"\nop somebody')])).rejects.toThrow();
        expect(fake.runs).toEqual([]);
    });

    it("sends each line again on its own when the batch is refused", async () => {
        fake.code = 1;
        const { server } = await service.openServerContainer("owner", "mc");
        await expect(server.sayAll([line('"a"'), line('"b"')])).rejects.toThrow();
        expect(fake.runs[1]).toEqual(["rcon-cli", line('"a"')]);
    });

    it("gives up on a batch the server never answers", async () => {
        vi.useFakeTimers();
        fake.hang = true;
        const { server } = await service.openServerContainer("owner", "mc");
        const sending = server.sayAll([line('"a"')]);
        const failed = expect(sending).rejects.toThrow("did not answer in time");
        await vi.advanceTimersByTimeAsync(16_000);
        await failed;
    });

    it("sends Bedrock lines one at a time through its console", async () => {
        fake.edition = "minecraft-bedrock";
        const { server } = await service.openServerContainer("owner", "mc");
        await server.sayAll([line('"a"'), line('"b"')]);
        expect(fake.runs).toEqual([
            ["send-command", line('"a"')],
            ["send-command", line('"b"')]
        ]);
    });
});

/**
 * Orchestration in `fivem/service.ts` that only shows up once the pure helpers
 * are wired together against a running server - a review pass found three of
 * these were still open: a resource archive picked its unpacker from the whole
 * link instead of the path, a console argument was sent unquoted, and the last
 * player could be taken off an exclusive allow list, locking its own owner out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every command the fake container was asked to run, in order. */
let ran: string[][] = [];

/** Every console command the fake transport was asked to send. */
let sentCommands: string[] = [];

/** What the next container command answers with. */
let containerAnswer = { code: 0, output: "" };

/** The install's settings blob, as `configOf`/`patchInstallConfig` see it. */
let config: Record<string, unknown> = {};

vi.mock("@/lib/apps/fivem/transport", () => ({
    NO_HTTP_CLIENT: 97,
    RCON_PASSWORD_VAR: "RCON_PASSWORD",
    withFivemServer: async (_ownerId: string, _installedAppId: string, work: (server: unknown) => unknown) =>
        work({
            running: true,
            document: async () => ({}),
            rcon: async (command: string) => {
                sentCommands.push(command);
                return "";
            },
            container: {
                run: async (argv: readonly string[]) => {
                    ran.push([...argv]);
                    return containerAnswer;
                }
            }
        })
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: vi.fn(async () => ({ config: JSON.stringify(config) })),
            findUnique: vi.fn(async () => ({ config: JSON.stringify(config) })),
            update: vi.fn(async () => undefined)
        }
    }
}));
vi.mock("@/lib/apps/catalog", () => ({ findApp: () => null, appHasCapability: () => false }));
vi.mock("@/lib/apps/games-health", () => ({
    readCrashLoop: async () => null,
    readRestartWatch: async () => null
}));
vi.mock("@/lib/app-container-metrics", () => ({
    readAppContainerMetricsOrNull: async () => null,
    readAppContainerRuntime: async () => null
}));
vi.mock("@/lib/deploy-service", () => ({ readAppRuntimeLog: async () => "" }));
vi.mock("@/lib/env-var-service", () => ({
    setEnvVars: vi.fn(async () => undefined),
    revealEnvVar: vi.fn(async () => null)
}));
vi.mock("@/lib/apps/install-config", () => ({
    patchInstallConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        config = { ...config, ...patch };
    }),
    readInstallConfig: (raw: string | null | undefined) => (raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
}));

const { installResourceFromUrl, messageFivemPlayer, removeAllowedPlayer, setFivemAdmin } = await import(
    "@/lib/apps/fivem/service"
);

beforeEach(() => {
    ran = [];
    sentCommands = [];
    containerAnswer = { code: 0, output: "" };
    config = {};
});

describe("installing a resource from a link", () => {
    it("unpacks a signed zip with unzip, reading the archive kind off the path and not the whole link", async () => {
        await installResourceFromUrl("owner-1", "install-1", "https://example.com/res.zip?token=abc", "myresource");

        const script = ran.find((argv) => argv[0] === "sh")?.[2] ?? "";
        expect(script).toContain("unzip -q");
        expect(script).not.toContain("tar xzf");
    });

    it("unpacks a signed tarball with tar, for the same reason", async () => {
        await installResourceFromUrl(
            "owner-1",
            "install-1",
            "https://example.com/res.tar.gz?token=abc",
            "myresource"
        );

        const script = ran.find((argv) => argv[0] === "sh")?.[2] ?? "";
        expect(script).toContain("tar xzf");
        expect(script).not.toContain("unzip -q");
    });

    it("refuses a link that names no archive at all, before touching the container", async () => {
        await expect(
            installResourceFromUrl("owner-1", "install-1", "https://example.com/y?file=res.zip", "myresource")
        ).rejects.toThrow();
        expect(ran).toEqual([]);
    });
});

describe("messaging one player", () => {
    it("quotes the message as a single console argument", async () => {
        await messageFivemPlayer("owner-1", "install-1", 3, "watch your language");

        expect(sentCommands).toHaveLength(1);
        expect(sentCommands[0]).toBe('polaris_dm 3 "watch your language"');
    });

    it("refuses a message the console cannot carry, before sending anything", async () => {
        await expect(messageFivemPlayer("owner-1", "install-1", 3, 'say "hi"')).rejects.toThrow();
        expect(sentCommands).toEqual([]);
    });
});

describe("taking somebody off the allow list", () => {
    beforeEach(() => {
        config = {
            fivemAllowList: [{ identifier: "license:abc123", label: "Alice", addedAt: "2026-01-01T00:00:00.000Z", appliedAt: null }]
        };
    });

    it("refuses to empty the list while the server is exclusive, which would lock its own owner out", async () => {
        config.fivemExclusiveJoin = true;

        await expect(removeAllowedPlayer("owner-1", "install-1", "license:abc123")).rejects.toThrow(
            /Open the server to everyone first/
        );
        expect(config.fivemAllowList).toHaveLength(1);
    });

    it("allows emptying the list once the server is open to everyone", async () => {
        config.fivemExclusiveJoin = false;

        const view = await removeAllowedPlayer("owner-1", "install-1", "license:abc123");

        expect(view.allowList).toEqual([]);
    });
});

describe("making somebody an admin", () => {
    it("sends the identifier through the same quoting every other console argument gets", async () => {
        await setFivemAdmin("owner-1", "install-1", { identifier: "license:abc123", label: "Alice" }, true);

        const principalCommand = sentCommands.find((command) => command.startsWith("add_principal"));
        // An identifier can never itself carry a space or a `;` - `isIdentifier`
        // refuses those before this is reached - so the quoting this review pass
        // added leaves it exactly as it was. It is exercised here anyway, so a
        // change that let something unsafe reach `add_principal` unquoted again
        // would fail loudly instead of only in a container nobody was watching.
        expect(principalCommand).toBe("add_principal identifier.license:abc123 group.admin");
    });
});

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

/** Set to have the fake server refuse every console command, which is what a
 *  dropped datagram looks like from here. */
let consoleRefuses = false;

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
                if (consoleRefuses) throw new Error("The server did not answer in time");
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
            findFirst: vi.fn(async () => ({
                config: JSON.stringify(config),
                catalogId: "fivem",
                applicationId: "app-1"
            })),
            findUnique: vi.fn(async () => ({ config: JSON.stringify(config), sourceConfig: "{}" })),
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

const { setEnvVars } = await import("@/lib/env-var-service");

const {
    applyPendingSetup,
    installResourceFromUrl,
    messageFivemPlayer,
    removeAllowedPlayer,
    setConsolePassword,
    setFivemAdmin,
    writeFivemRules
} = await import("@/lib/apps/fivem/service");

beforeEach(() => {
    ran = [];
    sentCommands = [];
    containerAnswer = { code: 0, output: "" };
    consoleRefuses = false;
    config = {};
    vi.mocked(setEnvVars).mockClear();
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

describe("changing the console password", () => {
    it("tells the running server before it writes what Polaris will authenticate with", async () => {
        containerAnswer = { code: 0, output: "rcon_password abc" };

        await setConsolePassword("owner-1", "install-1", "NewPassword123");

        // The order is the whole of the fix: the environment is what Polaris
        // speaks, so it must never name a password the server has not been told.
        expect(sentCommands).toEqual(["set rcon_password NewPassword123"]);
        expect(vi.mocked(setEnvVars)).toHaveBeenCalledTimes(1);
    });

    it("changes nothing at all when the server did not take it", async () => {
        // One lost datagram used to leave Polaris speaking a password the server
        // had never heard, which the retry could not recover either - it would
        // have authenticated with the new one too. Now the failure is harmless:
        // nothing moved, and pressing the button again still speaks the password
        // that works.
        containerAnswer = { code: 0, output: "rcon_password abc" };
        consoleRefuses = true;

        await expect(setConsolePassword("owner-1", "install-1", "NewPassword123")).rejects.toThrow();

        expect(vi.mocked(setEnvVars)).not.toHaveBeenCalled();
        // And the config it would next boot on is untouched.
        expect(ran.some((argv) => argv.join(" ").includes("base64 -d"))).toBe(false);
    });
});

describe("changing the slot count", () => {
    it("mirrors it onto the install, so a stopped server still says what size it is", async () => {
        containerAnswer = { code: 0, output: "sv_maxclients 32" };

        await writeFivemRules("owner-1", "install-1", { sv_maxclients: "48" });

        expect(config.slots).toBe(48);
    });

    it("clears it when the line is taken out, rather than leaving the old number", async () => {
        config = { slots: 48 };
        containerAnswer = { code: 0, output: "sv_maxclients 48" };

        await writeFivemRules("owner-1", "install-1", { sv_maxclients: null });

        expect(config.slots).toBe(null);
    });

    it("leaves it alone when the change was about something else", async () => {
        config = { slots: 48 };
        containerAnswer = { code: 0, output: "sv_hostname x" };

        await writeFivemRules("owner-1", "install-1", { sv_hostname: "Los Santos" });

        expect(config.slots).toBe(48);
    });
});

describe("handing a new server what it was created with", () => {
    it("does the work once when the poll and the sweep arrive together", async () => {
        // Both callers live in this process and the work between reading the
        // pending key and clearing it ends in a stop and a start of the deploy.
        // Without a claim, both would restart a server minutes old.
        config = { fivemPendingSetup: { settings: { sv_hostname: "Los Santos" } } };
        containerAnswer = { code: 0, output: "sv_hostname x" };

        const [first, second] = await Promise.all([
            applyPendingSetup("owner-1", "install-1"),
            applyPendingSetup("owner-1", "install-1")
        ]);

        expect(first).toBe(second);
        expect(config.fivemPendingSetup).toBe(null);
    });

    it("does nothing at all once there is nothing pending, which is every later poll", async () => {
        config = {};

        expect(await applyPendingSetup("owner-1", "install-1")).toBe(false);
        expect(ran).toEqual([]);
    });
});

/**
 * Setting a connected server up to serve its own domains.
 *
 * The setup installs Docker and writes under /var/lib/polaris, which needs root,
 * and Polaris signs in as an ordinary login. A server enrolled with root access
 * lets that login act as root through sudo - and the setup used to run without
 * it, so a server marked Root failed with `mkdir: cannot create directory
 * '/var/lib/polaris': Permission denied`. What is pinned here is that the script
 * runs under sudo exactly when it has to, never carries its secret on a command
 * line, and that a refusal is said as what to do about it.
 */

import type { ClaimEnrollmentInput } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

let connection = { username: "polaris", sudo: true };
let commands: { command: string; input?: string }[] = [];
let probe = "traefik=none\nguard=none\npushable=false\n";
let setupAnswer = { code: 0, stderr: "" };
let events: { action: string; values?: unknown }[] = [];

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_ACME_EMAIL: "ops@example.com", POLARIS_AUTH_SECRET: "s3cret-value" })
}));
vi.mock("@/lib/domain-service", () => ({
    publicAppUrl: async () => "https://polaris.example.com"
}));
vi.mock("@/lib/host-service", () => ({
    getHostConnection: async () => ({
        id: "h1",
        name: "ubuntu",
        address: "203.0.113.10",
        port: 22,
        auth: { method: "key", privateKey: "k" },
        ...connection
    })
}));
vi.mock("@/lib/deploy-target-service", () => ({
    getOrCreateHostTarget: async () => ({ proxyNetwork: "polaris-net" })
}));
vi.mock("@/lib/server-notes-service", () => ({
    recordServerEvent: async (
        _host: string,
        _actor: string | null,
        action: string,
        values?: unknown
    ) => {
        events.push({ action, values });
    }
}));
vi.mock("@polaris/ssh", () => ({
    openSshClient: async () => ({ end: () => {} }),
    execCommand: async (
        _client: unknown,
        command: string,
        options: {
            input?: string;
            onStdout?: (chunk: Buffer) => void;
            onStderr?: (chunk: Buffer) => void;
        }
    ) => {
        commands.push({ command, input: options.input });
        if (command.includes("docker inspect")) {
            options.onStdout?.(Buffer.from(probe));
            return { code: 0 };
        }
        if (setupAnswer.stderr) options.onStderr?.(Buffer.from(setupAnswer.stderr));
        return { code: setupAnswer.code };
    }
}));

const { edgeLauncher, NEEDS_ROOT, prepareServerEdge, setUpNewServer, setupFailure } = await import(
    "@/lib/deploy/server-edge"
);
const { setsUpOnEnrollment } = await import("@/lib/enrollment-setup");

beforeEach(() => {
    connection = { username: "polaris", sudo: true };
    commands = [];
    probe = "traefik=none\nguard=none\npushable=false\n";
    setupAnswer = { code: 0, stderr: "" };
    events = [];
});

describe("running the setup", () => {
    it("runs it as root through sudo on a server enrolled with root", async () => {
        await prepareServerEdge("h1", "o1", "polaris-net");
        const [run] = commands;
        expect(run?.command).toContain('sudo -n "$shell" "$f"');
        // And hands what the login writes into back to it.
        expect(run?.input).toContain("chown polaris /var/lib/polaris");
    });

    it("keeps the script, and the secret in it, off the command line", async () => {
        await prepareServerEdge("h1", "o1", "polaris-net");
        const [run] = commands;
        expect(run?.command).not.toContain("s3cret-value");
        expect(run?.input).toContain("s3cret-value");
    });

    it("needs no sudo when Polaris signs in as root", async () => {
        connection = { username: "root", sudo: false };
        await prepareServerEdge("h1", "o1", "polaris-net");
        const [run] = commands;
        expect(run?.command).not.toContain("sudo");
        expect(run?.input).not.toContain("chown");
    });

    it("tries without sudo where none was granted, and says root is what is missing", async () => {
        connection = { username: "polaris", sudo: false };
        setupAnswer = {
            code: 1,
            stderr: "mkdir: cannot create directory '/var/lib/polaris': Permission denied\n"
        };
        await expect(prepareServerEdge("h1", "o1", "polaris-net")).rejects.toThrow(NEEDS_ROOT);
        expect(commands[0]?.command).not.toContain("sudo");
    });
});

describe("the launcher", () => {
    it("writes the script to a private file and removes it whatever happens", () => {
        const launcher = edgeLauncher(true);
        expect(launcher).toContain("mktemp");
        expect(launcher).toContain('cat > "$f"');
        expect(launcher).toContain("trap 'rm -f \"$f\"' EXIT");
    });

    it("only asks for root when told to", () => {
        expect(edgeLauncher(false)).not.toContain("sudo");
    });
});

describe("what a failed setup says", () => {
    it("names missing root rather than a path", () => {
        const said = setupFailure(
            "mkdir: cannot create directory '/var/lib/polaris': Permission denied",
            false
        );
        expect(said).toBe(NEEDS_ROOT);
        expect(said).toMatch(/Add server/);
    });

    it("says the sudo rule is gone when root was granted and refused", () => {
        expect(setupFailure("sudo: a password is required", true)).toMatch(
            /no longer lets Polaris act as root/
        );
        expect(setupFailure("chown: changing ownership: Operation not permitted", true)).toMatch(
            /refused to let Polaris act as root/
        );
    });

    it("passes anything else through as its last line", () => {
        expect(setupFailure("pulling\nError: port 80 is already allocated\n", true)).toBe(
            "Error: port 80 is already allocated"
        );
        expect(setupFailure("", true)).toBe("That server refused to set itself up");
    });
});

describe("a server that has just been enrolled", () => {
    it("is set up without anybody pressing the button", async () => {
        await setUpNewServer("h1", "o1", "ubuntu");
        expect(commands.some((run) => run.command.includes("mktemp"))).toBe(true);
        expect(events).toEqual([{ action: "edge-ready", values: undefined }]);
    });

    it("keeps an edge that is already running", async () => {
        // Setting up again stops what it serves for a moment; that is the
        // operator's call, not something to do behind their back.
        probe = "traefik=true\nguard=true\npushable=true\n";
        await setUpNewServer("h1", "o1", "ubuntu");
        expect(commands.some((run) => run.command.includes("mktemp"))).toBe(false);
        expect(events).toEqual([]);
    });

    it("writes down why it could not be set up", async () => {
        setupAnswer = { code: 1, stderr: "Error: port 80 is already allocated\n" };
        await setUpNewServer("h1", "o1", "ubuntu");
        expect(events).toEqual([
            { action: "edge-failed", values: { to: "Error: port 80 is already allocated" } }
        ]);
    });
});

describe("which enrollments are set up", () => {
    const payload = (overrides: Partial<ClaimEnrollmentInput> = {}): ClaimEnrollmentInput =>
        ({
            hostname: "ubuntu",
            platform: "linux",
            arch: "x86_64",
            username: "polaris",
            port: 22,
            hostKeys: ["ssh-ed25519 AAAA"],
            addresses: [],
            docker: true,
            root: true,
            ...overrides
        }) as ClaimEnrollmentInput;

    it("a Linux server with root", () => {
        expect(setsUpOnEnrollment("server", payload())).toBe(true);
    });

    it("not one without root, which the setup cannot do without", () => {
        expect(setsUpOnEnrollment("server", payload({ root: false }))).toBe(false);
    });

    it("not a Mac, a runner, or the machine Polaris runs on", () => {
        expect(setsUpOnEnrollment("server", payload({ platform: "darwin" }))).toBe(false);
        expect(setsUpOnEnrollment("runner", payload())).toBe(false);
        expect(setsUpOnEnrollment("local", payload())).toBe(false);
    });
});

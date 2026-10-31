/**
 * A Docker gateway failing SSH logins stands in for whoever came through it. The SSH
 * jail drops an address in the server's own firewall before it records the ban, so
 * the check in `recordWafBan` comes too late for this path: a host block with no ban
 * row behind it is one nothing on the Firewall screen can lift.
 */

import { DEFAULT_WAF_JAILS } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-08-02T21:10:00.000Z");
const CONTAINER = "172.19.0.1";
const PUBLIC = "203.0.113.7";

const state = vi.hoisted(() => ({
    bans: [] as string[],
    scripts: [] as string[],
    log: ""
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        host: { findMany: async () => [{ id: "h1", name: "vps", ownerId: "u1", sudo: true }] },
        wafBan: { findMany: async () => [] }
    }
}));
vi.mock("@/lib/host-service", () => ({
    getHostConnection: async () => ({ address: "192.0.2.1", port: 22, username: "root", auth: {} })
}));
vi.mock("@/lib/waf-ban-service", async () => {
    const { DEFAULT_WAF_JAILS: jails } = await import("@polaris/core");
    return {
        getWafJails: async () =>
            jails
                .filter((jail) => jail.id === "ssh-auth")
                .map((jail) => ({ ...jail, enabled: true }))
    };
});
vi.mock("@polaris/ssh", () => ({
    openSshClient: async () => ({ end: () => undefined }),
    execCommand: async (
        _client: unknown,
        command: string,
        options: { onStdout?: (chunk: Buffer) => void; input?: string }
    ) => {
        if (options.input) state.scripts.push(options.input);
        else options.onStdout?.(Buffer.from(state.log));
        return { code: 0 };
    }
}));
vi.mock("@/lib/waf-intel-service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/waf-intel-service")>()),
    wafTrustedAddresses: async () => [],
    publishWafIntel: async () => undefined,
    recordWafBan: async (ban: { ip: string }) => {
        state.bans.push(ban.ip);
    }
}));

const { runSshJails } = await import("@/lib/waf-ssh-service");

function failures(ip: string): string[] {
    const jail = DEFAULT_WAF_JAILS.find((entry) => entry.id === "ssh-auth");
    return Array.from(
        { length: (jail?.maxRetry ?? 5) + 5 },
        (_, index) =>
            `Aug  2 21:04:${String(index).padStart(2, "0")} vps sshd[1]: Failed password for root from ${ip} port 1 ssh2`
    );
}

beforeEach(() => {
    state.bans = [];
    state.scripts = [];
    state.log = [...failures(CONTAINER), ...failures(PUBLIC)].join("\n");
});

describe("the SSH jail and container addresses", () => {
    it("neither blocks nor counts a container address, and still bans a public one", async () => {
        const result = await runSshJails(NOW);
        expect(result.banned).toBe(1);
        expect(state.bans).toEqual([PUBLIC]);
        expect(state.scripts).toHaveLength(1);
        expect(state.scripts[0]).toContain(PUBLIC);
        expect(state.scripts[0]).not.toContain(CONTAINER);
    });
});

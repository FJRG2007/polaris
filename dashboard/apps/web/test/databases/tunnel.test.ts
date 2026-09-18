/**
 * Reaching a database through SSH.
 *
 * The parts that matter here are the ones nobody sees fail safely: a jump server
 * that is hung up on when the second hop refuses, a tunnel that closes with the
 * call whatever the call did, and a driver that is pointed at the loopback port
 * rather than at an address only the far side can see.
 */

import type { SshConnectOptions } from "@polaris/ssh";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    captureHostKey,
    connectTunnel,
    openTunnel,
    TunnelError,
    type DataTunnel
} from "@/lib/data/tunnel";

interface FakeClient {
    readonly name: string;
    ended: boolean;
    end(): void;
}

const opened: FakeClient[] = [];
const forwarded: { host: string; port: number }[] = [];
let refuse: string | null = null;

function client(name: string): FakeClient {
    const made: FakeClient = {
        name,
        ended: false,
        end() {
            made.ended = true;
        }
    };
    opened.push(made);
    return made;
}

const deps = {
    connect: async (options: SshConnectOptions) => {
        if (refuse === options.host) throw new Error("refused");
        return client(`${options.host}${options.sock ? " (through a channel)" : ""}`) as never;
    },
    forward: (async (_client: unknown, host: string, port: number) => {
        forwarded.push({ host, port });
        return { channel: `${host}:${port}` } as never;
    }) as never
};

const TARGET: SshConnectOptions = {
    host: "ssh.example.com",
    port: 22,
    username: "root",
    auth: { method: "password", password: "hunter2" },
    pinnedHostKey: ["AAAA"]
};
const JUMP: SshConnectOptions = {
    host: "bastion.example.com",
    port: 22,
    username: "polaris",
    auth: { method: "key", privateKey: "key" },
    pinnedHostKey: ["BBBB"]
};

const direct: DataTunnel = { target: TARGET, jump: null, label: "ssh.example.com" };
const viaJump: DataTunnel = { target: TARGET, jump: JUMP, label: "ssh.example.com" };

beforeEach(() => {
    opened.length = 0;
    forwarded.length = 0;
    refuse = null;
});

describe("connectTunnel", () => {
    it("opens one connection when there is no jump server", async () => {
        const clients = (await connectTunnel(direct, deps)) as unknown as FakeClient[];
        expect(clients.map((entry) => entry.name)).toEqual(["ssh.example.com"]);
        expect(forwarded).toEqual([]);
    });

    it("reaches the SSH server through the jump server's own channel", async () => {
        const clients = (await connectTunnel(viaJump, deps)) as unknown as FakeClient[];
        expect(forwarded).toEqual([{ host: "ssh.example.com", port: 22 }]);
        // The target first: it is the one a forward is opened on, and the one
        // that has to be closed first.
        expect(clients.map((entry) => entry.name)).toEqual([
            "ssh.example.com (through a channel)",
            "bastion.example.com"
        ]);
    });

    it("hangs up on the jump server when the second hop refuses", async () => {
        refuse = "ssh.example.com";
        await expect(connectTunnel(viaJump, deps)).rejects.toThrow("refused");
        expect(opened).toHaveLength(1);
        expect(opened[0]!.ended).toBe(true);
    });
});

describe("openTunnel", () => {
    it("forwards a loopback port to the database and closes everything after", async () => {
        const tunnel = await openTunnel(direct, "127.0.0.1", 5432, deps);
        expect(tunnel.host).toBe("127.0.0.1");
        expect(tunnel.port).toBeGreaterThan(0);
        tunnel.close();
        expect(opened.every((entry) => entry.ended)).toBe(true);
    });

    it("says what could not be reached rather than passing the SSH error on", async () => {
        refuse = "ssh.example.com";
        const failed = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(openTunnel(direct, "127.0.0.1", 5432, deps)).rejects.toThrow(TunnelError);
        await expect(openTunnel(direct, "127.0.0.1", 5432, deps)).rejects.toThrow(
            /ssh.example.com/
        );
        failed.mockRestore();
    });
});

describe("captureHostKey", () => {
    it("returns the key the server presented and keeps no connection open", async () => {
        const connect = async (options: SshConnectOptions) => {
            options.onHostKey?.("PRESENTED");
            return client(options.host) as never;
        };
        const key = await captureHostKey(TARGET, JUMP, { connect, forward: deps.forward });
        expect(key).toBe("PRESENTED");
        expect(opened.every((entry) => entry.ended)).toBe(true);
    });

    it("fails when the handshake never presented one", async () => {
        await expect(captureHostKey(TARGET, null, deps)).rejects.toThrow(/host key/);
    });

    it("says the key changed when the server presents one the caller did not pin", async () => {
        // What a real verifier does: the key is reported, then refused, and the
        // credential is never sent.
        const connect = async (options: SshConnectOptions) => {
            options.onHostKey?.("SOMETHING-ELSE");
            throw new Error("Handshake failed: no matching host key");
        };

        await expect(
            captureHostKey(TARGET, null, { connect, forward: deps.forward })
        ).rejects.toThrow(/different key than the one Polaris pinned/);
    });

    it("passes a failure that was not the key through as itself", async () => {
        const connect = async (options: SshConnectOptions) => {
            options.onHostKey?.("AAAA");
            throw new Error("All configured authentication methods failed");
        };

        await expect(
            captureHostKey(TARGET, null, { connect, forward: deps.forward })
        ).rejects.toThrow(/authentication methods failed/);
    });
});

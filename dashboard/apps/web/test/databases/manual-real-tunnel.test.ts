/**
 * MANUAL VERIFICATION - not part of the committed suite.
 *
 * Every other tunnel test fakes `connect`/`forward`, so the real ssh2 client,
 * the real host-key verifier and the real loopback forwarder in ssh-forward.ts
 * never run end-to-end anywhere in the suite. This spins up real ssh2 servers
 * and a real TCP stand-in for a database, and drives the actual (unmocked)
 * captureHostKey/connectTunnel/openTunnel against them the way a browser
 * action ultimately would.
 */
import net from "node:net";
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { Server as SshServer, type Connection } from "ssh2";
import { openSshClient, forwardOut, type SshConnectOptions } from "@polaris/ssh";
import {
    captureHostKey,
    connectTunnel,
    openTunnel,
    TunnelError,
    type DataTunnel
} from "@/lib/data/tunnel";

function hostKeyPem(): string {
    const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs1", format: "pem" }
    });
    return privateKey;
}

/** A real sshd-like server: password auth, and direct-tcpip forwarded to
 *  whatever address/port the client asks for (an sshd with AllowTcpForwarding). */
function startSshServer(
    username: string,
    password: string
): Promise<{ port: number; close: () => void }> {
    return new Promise((resolve) => {
        const server = new SshServer({ hostKeys: [hostKeyPem()] }, (client: Connection) => {
            client
                .on("authentication", (ctx) => {
                    if (
                        ctx.method === "password" &&
                        ctx.username === username &&
                        ctx.password === password
                    ) {
                        return ctx.accept();
                    }
                    ctx.reject(["password"]);
                })
                .on("ready", () => {
                    client.on("tcpip", (accept, _reject, info) => {
                        const channel = accept();
                        const socket = net.connect(info.destPort, info.destIP);
                        socket.pipe(channel).pipe(socket);
                        socket.on("error", () => channel.close());
                        channel.on("error", () => socket.destroy());
                    });
                })
                .on("error", () => undefined);
        });
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resolve({ port, close: () => server.close() });
        });
    });
}

/** Stands in for the database: greets the caller, then echoes anything sent. */
function startFakeDatabase(): Promise<{ port: number; close: () => void }> {
    return new Promise((resolve) => {
        const server = net.createServer((socket) => {
            socket.write("FAKE_DB_READY\n");
            socket.on("data", (chunk) => socket.write(`DB_ECHO:${chunk.toString()}`));
        });
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resolve({ port, close: () => server.close() });
        });
    });
}

function speak(host: string, port: number, message: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, host);
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString();
            if (buffer.includes("DB_ECHO:")) {
                socket.end();
                resolve(buffer);
            }
        });
        socket.on("error", reject);
        socket.on("connect", () => socket.write(message));
    });
}

describe("a real SSH tunnel reaching a database (unmocked)", () => {
    it("pins the target's host key on first contact, then reaches the database through it", async () => {
        const db = await startFakeDatabase();
        const ssh = await startSshServer("dbuser", "correct horse battery staple");
        try {
            const target: Omit<SshConnectOptions, "onHostKey" | "sock"> = {
                host: "127.0.0.1",
                port: ssh.port,
                username: "dbuser",
                auth: { method: "password", password: "correct horse battery staple" }
            };

            const pinned = await captureHostKey(target, null);
            expect(pinned.length).toBeGreaterThan(0);
            console.log(
                "[manual] captured and pinned target host key:",
                `${pinned.slice(0, 24)}...`
            );

            const tunnel: DataTunnel = {
                target: { ...target, pinnedHostKey: pinned },
                jump: null,
                label: "127.0.0.1"
            };
            const opened = await openTunnel(tunnel, "127.0.0.1", db.port);
            console.log(
                `[manual] loopback tunnel listening at ${opened.host}:${opened.port} -> db 127.0.0.1:${db.port}`
            );
            try {
                const reply = await speak(opened.host, opened.port, "SELECT 1");
                console.log("[manual] round trip through the tunnel:", JSON.stringify(reply));
                expect(reply).toBe("FAKE_DB_READY\nDB_ECHO:SELECT 1");
            } finally {
                opened.close();
            }

            // A server that answers with a DIFFERENT key than the one just pinned
            // (a rebuilt host, or an attacker in the middle) must be refused, not
            // silently reconnected to.
            const wrongPin: DataTunnel = {
                target: { ...target, pinnedHostKey: "AAAAthis-is-not-the-real-key" },
                jump: null,
                label: "127.0.0.1"
            };
            await expect(connectTunnel(wrongPin)).rejects.toThrow();
            console.log(
                "[manual] connection refused when the presented key did not match the pin - confirmed"
            );
        } finally {
            ssh.close();
            db.close();
        }
    }, 20_000);

    it("reaches the database through a jump server, chaining two real SSH hops", async () => {
        const db = await startFakeDatabase();
        const target = await startSshServer("dbuser", "target-pass");
        const jump = await startSshServer("jumpuser", "jump-pass");
        try {
            const targetOptions: Omit<SshConnectOptions, "onHostKey" | "sock"> = {
                host: "127.0.0.1",
                port: target.port,
                username: "dbuser",
                auth: { method: "password", password: "target-pass" }
            };
            const jumpOptions: SshConnectOptions = {
                host: "127.0.0.1",
                port: jump.port,
                username: "jumpuser",
                auth: { method: "password", password: "jump-pass" },
                pinnedHostKey: await captureHostKey(
                    {
                        host: "127.0.0.1",
                        port: jump.port,
                        username: "jumpuser",
                        auth: { method: "password", password: "jump-pass" }
                    },
                    null
                )
            };
            const targetPinned = await captureHostKey(targetOptions, jumpOptions);

            const tunnel: DataTunnel = {
                target: { ...targetOptions, pinnedHostKey: targetPinned },
                jump: jumpOptions,
                label: "127.0.0.1 (via jump)"
            };
            const opened = await openTunnel(tunnel, "127.0.0.1", db.port);
            console.log(`[manual] jump-chained tunnel listening at ${opened.host}:${opened.port}`);
            try {
                const reply = await speak(opened.host, opened.port, "PING");
                console.log(
                    "[manual] round trip through jump + target + db:",
                    JSON.stringify(reply)
                );
                expect(reply).toBe("FAKE_DB_READY\nDB_ECHO:PING");
            } finally {
                opened.close();
            }
        } finally {
            target.close();
            jump.close();
            db.close();
        }
    }, 20_000);

    it("refuses to open when the SSH login itself is wrong", async () => {
        const ssh = await startSshServer("dbuser", "right-password");
        try {
            const target: SshConnectOptions = {
                host: "127.0.0.1",
                port: ssh.port,
                username: "dbuser",
                auth: { method: "password", password: "wrong-password" },
                pinnedHostKey: await captureHostKey(
                    {
                        host: "127.0.0.1",
                        port: ssh.port,
                        username: "dbuser",
                        auth: { method: "password", password: "right-password" }
                    },
                    null
                )
            };
            const tunnel: DataTunnel = { target, jump: null, label: "127.0.0.1" };
            await expect(openTunnel(tunnel, "127.0.0.1", 1)).rejects.toThrow(TunnelError);
        } finally {
            ssh.close();
        }
    }, 20_000);
});

// keep the real forwardOut import reachable for readers checking this exercises
// the same primitive listenForward/connectTunnel use internally.
void forwardOut;
void openSshClient;

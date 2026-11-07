/**
 * Installing on a TV: the ADB client against a fake device speaking the real
 * framing, and the checks that decide whether anything may be done to a set.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { createHash, createPublicKey, publicDecrypt, constants } from "node:crypto";
import { CHANNELS } from "@/shared/bridge";
import { readTvAddress } from "@/shared/tv-address";
import {
    AdbConnection,
    androidPublicKey,
    encodePacket,
    newAdbKey,
    PacketReader,
    signToken
} from "../../src/main/adb-client";
import { PairingError } from "../../src/main/adb-pairing";

const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw?: unknown) => unknown>());

vi.mock("electron", () => ({
    app: { getPath: () => "" },
    BrowserWindow: class {},
    ipcMain: { handle: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => handlers.set(channel, handler) }
}));
vi.mock("../../src/main/windows", () => ({
    openLocalWindow: () => null,
    kindOf: (sender: { kind: string; }) => sender.kind
}));

const { connectFailure, grantCommands, homeIsOurs, lateFailure, latestApk, pairingFailure, PRIVATE_DNS_READ, registerTvInstall, tvRefusal } =
    await import(
    "../../src/main/tv-install"
);

const CNXN = 0x4e584e43;
const AUTH = 0x48545541;
const OPEN = 0x4e45504f;
const OKAY = 0x59414b4f;
const CLSE = 0x45534c43;
const WRTE = 0x45545257;
const KEY = newAdbKey();

describe("the packets", () => {
    it("reads what it writes, in pieces", () => {
        const data = Buffer.from("hello");
        const bytes = encodePacket(WRTE, 1, 2, data);
        const reader = new PacketReader();
        expect(reader.push(bytes.subarray(0, 10))).toEqual([]);
        const [packet] = reader.push(bytes.subarray(10));
        expect(packet).toMatchObject({ command: WRTE, arg0: 1, arg1: 2 });
        expect(packet?.data.toString()).toBe("hello");
    });

    it("refuses something that is not ADB", () => {
        expect(() => new PacketReader().push(Buffer.alloc(24, 0x41))).toThrow();
    });
});

describe("the key", () => {
    it("signs a token so the public half verifies it as a SHA-1 digest", () => {
        const token = Buffer.alloc(20, 7);
        const signature = signToken(KEY, token);
        const opened = publicDecrypt(
            { key: createPublicKey(KEY), padding: constants.RSA_PKCS1_PADDING },
            signature
        );
        expect(opened.subarray(-20)).toEqual(token);
        expect(signature.length).toBe(256);
    });

    it("writes Android's public key layout", () => {
        const text = androidPublicKey(KEY, "test").toString();
        expect(text.endsWith(" test\0")).toBe(true);
        const raw = Buffer.from(text.split(" ")[0] ?? "", "base64");
        expect(raw.length).toBe(4 + 4 + 256 + 256 + 4);
        expect(raw.readUInt32LE(0)).toBe(64);
        expect(raw.readUInt32LE(raw.length - 4)).toBe(65537);
        const n0 = raw.readUInt32LE(8);
        const n0inv = raw.readUInt32LE(4);
        expect((BigInt(n0) * BigInt(n0inv) + 1n) % (1n << 32n)).toBe(0n);
    });
});

/** A device that asks for a signature, then the public key, then answers shell and sync. */
function fakeDevice(pushed: { data: Buffer; }, shells: string[], asks: { prompted: number; }): Promise<Server> {
    return new Promise((resolve) => {
        const server = createServer((socket: Socket) => {
            const reader = new PacketReader();
            let authTries = 0;
            let syncLocal = 0;
            socket.on("data", (chunk) => {
                for (const packet of reader.push(chunk)) {
                    if (packet.command === CNXN) {
                        socket.write(encodePacket(AUTH, 1, 0, Buffer.alloc(20, 3)));
                    } else if (packet.command === AUTH) {
                        authTries += 1;
                        if (packet.arg0 === 2) socket.write(encodePacket(AUTH, 1, 0, Buffer.alloc(20, 4)));
                        else {
                            asks.prompted = authTries;
                            socket.write(encodePacket(CNXN, 0x01000000, 4096, Buffer.from("device::\0")));
                        }
                    } else if (packet.command === OPEN) {
                        const service = packet.data.toString().replace(/\0$/, "");
                        socket.write(encodePacket(OKAY, 99, packet.arg0));
                        if (service === "sync:") syncLocal = packet.arg0;
                        else {
                            shells.push(service.slice("shell:".length));
                            socket.write(encodePacket(WRTE, 99, packet.arg0, Buffer.from("Success\n")));
                            socket.write(encodePacket(CLSE, 99, packet.arg0));
                        }
                    } else if (packet.command === WRTE && packet.arg1 === 99) {
                        pushed.data = Buffer.concat([pushed.data, packet.data]);
                        socket.write(encodePacket(OKAY, 99, syncLocal));
                        if (packet.data.includes(Buffer.from("DONE"))) {
                            socket.write(encodePacket(WRTE, 99, syncLocal, Buffer.from("OKAY\0\0\0\0")));
                        }
                    }
                }
            });
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

describe("a session", () => {
    let server: Server | null = null;
    afterEach(() => server?.close());

    it("authenticates, prompts, runs a command and pushes a file larger than a packet", async () => {
        const pushed = { data: Buffer.alloc(0) };
        const shells: string[] = [];
        const asks = { prompted: 0 };
        server = await fakeDevice(pushed, shells, asks);
        const address = server.address() as { port: number; };
        const onPrompt = vi.fn();
        const adb = new AdbConnection({
            host: "127.0.0.1",
            port: address.port,
            key: KEY,
            connectMs: 2000,
            approveMs: 2000,
            commandMs: 2000,
            onPrompt
        });
        await adb.open();
        expect(onPrompt).toHaveBeenCalledOnce();
        expect(await adb.shell("pm install -r /x.apk")).toBe("Success\n");
        expect(shells).toEqual(["pm install -r /x.apk"]);
        const apk = Buffer.alloc(100_000, 0xab);
        await adb.push("/data/local/tmp/x.apk", apk);
        expect(pushed.data.subarray(0, 4).toString()).toBe("SEND");
        expect(pushed.data.includes(Buffer.from("/data/local/tmp/x.apk,420"))).toBe(true);
        expect(pushed.data.includes(apk.subarray(0, 60_000))).toBe(true);
        adb.close();
    });

    it("ends a wait on the TV's prompt as soon as it is closed, not when the prompt times out", async () => {
        const AUTH = 0x48545541;
        let events: { data(chunk: Buffer): void; } | null = null;
        // A TV that never accepts: every handshake packet is answered with a fresh token, and the key with nothing.
        const link = async (opened: { data(chunk: Buffer): void; }) => {
            events = opened;
            return {
                send: (header: Buffer) => {
                    if (header.readUInt32LE(0) !== AUTH || header.readUInt32LE(4) !== 3) {
                        queueMicrotask(() => events?.data(encodePacket(AUTH, 1, 0, Buffer.alloc(20, 7))));
                    }
                },
                close: () => undefined
            };
        };
        let prompt = () => undefined as void;
        const prompted = new Promise<void>((resolve) => {
            prompt = resolve;
        });
        const adb = new AdbConnection({
            link,
            key: KEY,
            connectMs: 2000,
            approveMs: 60_000,
            commandMs: 2000,
            onPrompt: () => prompt()
        });
        const opening = adb.open();
        await prompted;
        const started = Date.now();
        adb.close();
        await expect(opening).rejects.toThrow("The connection was closed.");
        expect(Date.now() - started).toBeLessThan(1000);
    });
});

describe("what it agrees to touch", () => {
    it("talks ADB only to private addresses", () => {
        expect(readTvAddress(" 192.168.1.50 ")).toBe("192.168.1.50");
        expect(readTvAddress("10.0.0.2")).toBe("10.0.0.2");
        expect(readTvAddress("172.20.1.1")).toBe("172.20.1.1");
        expect(readTvAddress("8.8.8.8")).toBeNull();
        expect(readTvAddress("172.32.0.1")).toBeNull();
        expect(readTvAddress("192.168.1.999")).toBeNull();
        expect(readTvAddress("tv.example.com")).toBeNull();
        expect(readTvAddress(undefined)).toBeNull();
    });

    it("refuses what is not an Android TV, and what is too old", () => {
        const tv = "feature:android.software.leanback\nfeature:android.hardware.wifi";
        expect(tvRefusal("30\n", tv)).toBeNull();
        expect(tvRefusal("26", tv)).toBeNull();
        expect(tvRefusal("25", tv)).toBe("too-old");
        expect(tvRefusal("", tv)).toBe("too-old");
        expect(tvRefusal("30", "feature:android.hardware.touchscreen")).toBe("not-android-tv");
    });

    it("confirms Home instead of assuming it", () => {
        expect(homeIsOurs("priority=0 preferredOrder=0\napp.polaris.tv/.MainActivity\n")).toBe(true);
        expect(homeIsOurs("com.google.android.tvlauncher/.MainActivity")).toBe(false);
        expect(homeIsOurs("com.google.android.tungsten.setupwraith/.RecoveryActivity")).toBe(false);
    });

    it("tells a closed port from a silent address", () => {
        expect(connectFailure({ code: "ECONNREFUSED" })).toBe("adb-off");
        expect(connectFailure({ message: "The TV stopped answering." })).toBe("not-allowed");
        expect(connectFailure({ code: "EHOSTUNREACH" })).toBe("unreachable");
    });
});

describe("who may use the window's channels", () => {
    // The TV window here; ipc.ts also lets a Polaris window on its own Polaris in.
    registerTvInstall((event) => (event.sender as unknown as { kind: string }).kind === "tv");
    const sent: unknown[] = [];
    const sender = (kind: string) => ({
        kind,
        once: () => undefined,
        isDestroyed: () => false,
        send: (_channel: string, state: unknown) => sent.push(state)
    });
    const call = (channel: string, kind: string, raw?: unknown) =>
        handlers.get(channel)?.({ sender: sender(kind) }, raw);

    it("answers only the TV window", async () => {
        expect(await call(CHANNELS.tvState, "polaris")).toBeNull();
        expect(await call(CHANNELS.tvFind, "connect")).toBeNull();
        expect(await call(CHANNELS.tvStart, "polaris", { host: "192.168.1.50", home: true })).toBe(false);
        expect(await call(CHANNELS.tvState, "tv")).toMatchObject({ phase: "ready" });
        expect(await call(CHANNELS.tvCancel, "polaris")).toBeNull();
    });

    it("cancels only a search, and leaves anything else as it was", async () => {
        expect(await call(CHANNELS.tvCancel, "tv")).toMatchObject({ phase: "ready" });
        expect(sent).toEqual([]);
    });

    it("refuses what is not a private address, or not the right shape", async () => {
        expect(await call(CHANNELS.tvStart, "tv", { host: "8.8.8.8", home: true })).toBe(false);
        expect(await call(CHANNELS.tvStart, "tv", { host: "192.168.1.50" })).toBe(false);
        expect(await call(CHANNELS.tvStart, "tv", undefined)).toBe(false);
    });

    it("refuses a pairing code that is not the TV's six digits", async () => {
        for (const code of ["", "12345", "1234567", "12ab56", "12 34 5"])
            expect(await call(CHANNELS.tvStart, "tv", { host: "192.168.1.50", home: true, code })).toBe(false);
    });
});

describe("a failed pairing", () => {
    it("says a wrong code apart from a TV that could not be reached, and keeps a cancel quiet", () => {
        expect(pairingFailure(new PairingError("wrong-code", "x"))).toBe("pairing-refused");
        expect(pairingFailure(new PairingError("cancelled", "x"))).toBe("cancelled");
        for (const reason of ["timeout", "unreachable", "protocol"] as const)
            expect(pairingFailure(new PairingError(reason, "x"))).toBe("unreachable");
        expect(pairingFailure(new Error("ECONNRESET"))).toBe("unreachable");
    });
});

describe("a failure part way through", () => {
    it("says how far it got", () => {
        expect(lateFailure("check")).toBe("connection-lost");
        expect(lateFailure("backup")).toBe("backup-failed");
        expect(lateFailure("send")).toBe("connection-lost");
        expect(lateFailure("install")).toBe("install-interrupted");
        expect(lateFailure("home")).toBe("installed-home-unknown");
    });
});

describe("the grants after the install", () => {
    it("grants location always, and secure settings only when ad blocking was asked for", () => {
        expect(grantCommands(false)).toEqual(["pm grant app.polaris.tv android.permission.ACCESS_FINE_LOCATION"]);
        expect(grantCommands(true)).toEqual([
            "pm grant app.polaris.tv android.permission.ACCESS_FINE_LOCATION",
            "pm grant app.polaris.tv android.permission.WRITE_SECURE_SETTINGS"
        ]);
    });

    it("never revokes or writes a setting", () => {
        for (const command of grantCommands(true)) expect(command).not.toMatch(/revoke|settings put/);
    });

    it("backs up the Private DNS mode and hostname by name, and only reads them", () => {
        expect(PRIVATE_DNS_READ).toContain("private_dns_mode=$(settings get global private_dns_mode)");
        expect(PRIVATE_DNS_READ).toContain("private_dns_specifier=$(settings get global private_dns_specifier)");
        expect(PRIVATE_DNS_READ).not.toMatch(/settings (put|delete)/);
    });
});

describe("finding the release", () => {
    afterEach(() => vi.unstubAllGlobals());

    const other = (at: number) => ({ tag_name: `desktop-v0.0.${at}`, draft: false, prerelease: false, assets: [] });
    const apk = Buffer.from("apk");
    const digest = createHash("sha256").update(apk).digest("hex");
    const tv = {
        tag_name: "tv-v1.2.3",
        draft: false,
        prerelease: false,
        assets: [
            { name: "polaris-tv.apk", browser_download_url: "https://files.example/apk" },
            { name: "SHA256SUMS", browser_download_url: "https://files.example/sums" }
        ]
    };

    function serve(pages: readonly (readonly unknown[])[], sums = `${digest}  polaris-tv.apk\n`) {
        const asked: string[] = [];
        vi.stubGlobal("fetch", async (url: string) => {
            asked.push(url);
            if (url.endsWith("/sums")) return new Response(sums);
            if (url.endsWith("/apk")) return new Response(apk);
            const page = Number(new URL(url).searchParams.get("page"));
            return Response.json(pages[page - 1] ?? []);
        });
        return asked;
    }

    it("walks past a full page of other releases", async () => {
        const asked = serve([Array.from({ length: 100 }, (_, at) => other(at)), [tv]]);
        expect(await latestApk()).toMatchObject({ version: "1.2.3" });
        expect(asked.filter((url) => url.includes("page=2"))).toHaveLength(1);
    });

    it("stops at a page that is not full and reports nothing released", async () => {
        const asked = serve([[other(1)]]);
        expect(await latestApk()).toBeNull();
        expect(asked).toHaveLength(1);
    });

    it("refuses an APK that does not match its checksum", async () => {
        serve([[tv]], `${"0".repeat(64)}  polaris-tv.apk\n`);
        await expect(latestApk()).rejects.toThrow();
    });
});

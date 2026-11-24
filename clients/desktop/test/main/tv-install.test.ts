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
import { choosePath } from "../../src/main/tv-path";

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

const { accessibilityEntries, alreadyLinked, apkNameOf, batteryWhitelisted, connectFailure, controlGrants, grantCommands, grantControl, homeControl, homeIsOurs, homeKeyCommands, homeKeyOn, installMode, installPackagesAllowed, lateFailure, listenerCommands, listenerEnabled, latestApk, LINK_STATE_READ, linkCommand, opened, pairingFailure, PRIVATE_DNS_READ, registerTvInstall, secureSettingsGranted, startSchema, tvRefusal, waitingFor } =
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

describe("the instruction while it waits", () => {
    it("names the steps it took its menus from, so the dashboard can read them in its own language", () => {
        const path = choosePath({ services: ["adb-tls-pairing"] }, null);
        const waiting = waitingFor("debugging", path);
        expect(waiting.steps).toBe(path.instruction.id);
        expect(waiting).toMatchObject({ step: "debugging", about: path.instruction.about, switches: path.instruction.switches });
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

describe("the link screen after the install", () => {
    it("opens the shell-only alias with this app's Polaris as a bare origin", () => {
        expect(linkCommand("https://polaris.example.com/home?x=1")).toBe(
            "am start -n app.polaris.tv/.LinkFromInstall --es origin https://polaris.example.com"
        );
        expect(linkCommand("http://192.168.1.20:3000")).toBe(
            "am start -n app.polaris.tv/.LinkFromInstall --es origin http://192.168.1.20:3000"
        );
    });

    it("does nothing without a Polaris, or with an address that is not plain http(s)", () => {
        expect(linkCommand(null)).toBeNull();
        expect(linkCommand("not a url")).toBeNull();
        expect(linkCommand("file:///etc/passwd")).toBeNull();
        expect(linkCommand("javascript:alert(1)")).toBeNull();
    });

    it("does nothing when the address is this computer's own loopback", () => {
        for (const address of ["http://localhost:3000", "http://app.localhost", "http://127.0.0.1:3000", "http://127.1.2.3", "http://[::1]:3000", "http://0.0.0.0", "http://[::ffff:127.0.0.1]"]) {
            expect(linkCommand(address)).toBeNull();
        }
    });

    it("leaves a TV that is already linked alone", () => {
        expect(LINK_STATE_READ).toBe("am broadcast -f 32 -n app.polaris.tv/.LinkState");
        expect(alreadyLinked('Broadcasting: Intent { flg=0x20 cmp=app.polaris.tv/.LinkState }\nBroadcast completed: result=0, data="linked=true"\n')).toBe(true);
        expect(alreadyLinked('Broadcast completed: result=0, data="linked=false"\n')).toBe(false);
        expect(alreadyLinked("Broadcast completed: result=0\n")).toBe(false);
        expect(alreadyLinked("")).toBe(false);
    });

    it("tells a started activity from am's errors", () => {
        expect(opened("Starting: Intent { cmp=app.polaris.tv/.LinkFromInstall (has extras) }\n")).toBe(true);
        expect(opened("Error type 3\nError: Activity class {app.polaris.tv/app.polaris.tv.LinkFromInstall} does not exist.")).toBe(false);
        expect(opened("java.lang.SecurityException: Permission Denial")).toBe(false);
        expect(opened("")).toBe(false);
    });
});

describe("the grants after the install", () => {
    it("grants location always and, in app mode, secure settings only when ad blocking was asked for", () => {
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

    it("fetches the Home key edition from its own asset and checksum line", async () => {
        const withEdition = {
            ...tv,
            assets: [...tv.assets, { name: "polaris-tv-home-key.apk", browser_download_url: "https://files.example/home-key/apk" }]
        };
        const asked = serve([[withEdition]], `${"0".repeat(64)}  polaris-tv.apk\n${digest}  polaris-tv-home-key.apk\n`);
        expect(apkNameOf("home-key")).toBe("polaris-tv-home-key.apk");
        expect(await latestApk("home-key")).toMatchObject({ version: "1.2.3" });
        expect(asked).toContain("https://files.example/home-key/apk");
    });

    it("reports the Home key edition unreleased when the newest release lacks it", async () => {
        serve([[tv]]);
        expect(await latestApk("home-key")).toBeNull();
    });
});

describe("the Home key service", () => {
    const service = "app.polaris.tv/.HomeKeyService";

    it("reads null and empty as no services, and refuses an answer that is not a list", () => {
        expect(accessibilityEntries("null\n")).toEqual([]);
        expect(accessibilityEntries("  \n")).toEqual([]);
        expect(accessibilityEntries("com.a/.One:com.b/com.b.Two$Inner\n")).toEqual(["com.a/.One", "com.b/com.b.Two$Inner"]);
        expect(accessibilityEntries("cmd: Can't find service: settings")).toBeNull();
    });

    it("puts the service after what is there, never in its place", () => {
        expect(homeKeyCommands([])).toEqual([
            `settings put secure enabled_accessibility_services '${service}'`,
            "settings put secure accessibility_enabled 1"
        ]);
        expect(homeKeyCommands(["com.a/.One", "com.b/.Two$X"])[0]).toBe(
            `settings put secure enabled_accessibility_services 'com.a/.One:com.b/.Two$X:${service}'`
        );
    });

    it("clears and writes back a list that already has it, so the service binds again", () => {
        const [first, last] = homeKeyCommands(["com.a/.One", "app.polaris.tv/app.polaris.tv.HomeKeyService"]);
        const list = "'com.a/.One:app.polaris.tv/app.polaris.tv.HomeKeyService'";
        expect(first).toBe(
            `settings put secure enabled_accessibility_services ''; settings put secure accessibility_enabled 0; sleep 1; settings put secure enabled_accessibility_services ${list}`
        );
        expect(last).toBe("settings put secure accessibility_enabled 1");
    });

    it("counts it on only when listed and accessibility is on", () => {
        expect(homeKeyOn(`com.a/.One:${service}\n1\n`)).toBe(true);
        expect(homeKeyOn("app.polaris.tv/app.polaris.tv.HomeKeyService\r\n1\r\n")).toBe(true);
        expect(homeKeyOn(`${service}\n0\n`)).toBe(false);
        expect(homeKeyOn("com.a/.One\n1\n")).toBe(false);
        expect(homeKeyOn("null\nnull\n")).toBe(false);
    });
});

describe("the install mode", () => {
    const host = "192.168.1.50";

    it("takes the mode when the page sends it, and reads home alone the way pages before it meant it", () => {
        expect(installMode({ mode: "app", home: true })).toBe("app");
        expect(installMode({ mode: "system" })).toBe("system");
        expect(installMode({ home: true })).toBe("system");
        expect(installMode({ home: false })).toBe("app");
    });

    it("accepts a page that sends only home, only mode, or both, and refuses one that sends neither", () => {
        expect(startSchema.safeParse({ host, home: false }).success).toBe(true);
        expect(startSchema.safeParse({ host, mode: "app" }).success).toBe(true);
        expect(startSchema.safeParse({ usb: "abc", mode: "system", home: true }).success).toBe(true);
        expect(startSchema.safeParse({ host }).success).toBe(false);
        expect(startSchema.safeParse({ usb: "abc" }).success).toBe(false);
        expect(startSchema.safeParse({ host, mode: "root" }).success).toBe(false);
    });
});

describe("full control of the TV", () => {
    const listener = "app.polaris.tv/.GuardRevival";
    const grant = (rung: string, sdk: number | null = 30) => controlGrants(sdk).find((one) => one.rung === rung)!;

    it("tries the levels strongest first, and only what the launcher declares", () => {
        expect(controlGrants(30).map((one) => one.rung)).toEqual(["secure-settings", "notification-listener", "install-packages", "battery"]);
        expect(grant("secure-settings").commands("")).toEqual(["pm grant app.polaris.tv android.permission.WRITE_SECURE_SETTINGS"]);
        expect(grant("install-packages").commands("")).toEqual(["appops set app.polaris.tv REQUEST_INSTALL_PACKAGES allow"]);
        expect(grant("battery").commands("")).toEqual(["dumpsys deviceidle whitelist +app.polaris.tv"]);
        const all = [...controlGrants(30), ...controlGrants(23)].flatMap((one) => one.commands("null") ?? []).join("\n");
        expect(all).not.toMatch(/GET_USAGE_STATS|SYSTEM_ALERT_WINDOW/);
    });

    it("puts the listener after what is there, never in its place", () => {
        expect(listenerCommands("null\n")).toEqual([`settings put secure enabled_notification_listeners '${listener}'`]);
        expect(listenerCommands("")).toEqual([`settings put secure enabled_notification_listeners '${listener}'`]);
        expect(listenerCommands("com.a/com.a.Listen:com.b/.Other$X\n")).toEqual([
            `settings put secure enabled_notification_listeners 'com.a/com.a.Listen:com.b/.Other$X:${listener}'`
        ]);
        expect(grant("notification-listener", 23).before).toBe("settings get secure enabled_notification_listeners");
        expect(grant("notification-listener", 23).commands("null")).toEqual([`settings put secure enabled_notification_listeners '${listener}'`]);
    });

    it("asks the notification service from Android 8 on, and believes only what it reports", () => {
        for (const sdk of [26, 30, null]) {
            const listen = grant("notification-listener", sdk);
            expect(listen.before).toBeUndefined();
            expect(listen.commands("")).toEqual([`cmd notification allow_listener ${listener}`]);
            expect(listen.check).toBe("dumpsys notification | grep -F GuardRevival");
        }
        expect(listenerEnabled("      ComponentInfo{app.polaris.tv/app.polaris.tv.GuardRevival}\n")).toBe(true);
        expect(listenerEnabled("    ManagedServiceInfo[component=ComponentInfo{app.polaris.tv/app.polaris.tv.GuardRevival},userid=0]\n")).toBe(true);
        expect(listenerEnabled("      app.polaris.tv/app.polaris.tv.GuardRevival\n")).toBe(false);
        expect(listenerEnabled("")).toBe(false);
    });

    it("writes nothing when it is listed already, in either spelling, or when the list is not a list", () => {
        expect(listenerCommands(`com.a/.One:${listener}`)).toEqual([]);
        expect(listenerCommands("app.polaris.tv/app.polaris.tv.GuardRevival")).toEqual([]);
        expect(listenerCommands("cmd: Can't find service: settings")).toBeNull();
        expect(listenerCommands("com.a/.One:not a component")).toBeNull();
    });

    it("counts each level only when the read-back shows it", () => {
        expect(secureSettingsGranted("      android.permission.WRITE_SECURE_SETTINGS: granted=true\n")).toBe(true);
        expect(secureSettingsGranted("      android.permission.WRITE_SECURE_SETTINGS: granted=false\n")).toBe(false);
        expect(secureSettingsGranted("")).toBe(false);
        expect(grant("notification-listener", 23).got(`com.a/.One:${listener}\n`)).toBe(true);
        expect(grant("notification-listener", 23).got("null\n")).toBe(false);
        expect(installPackagesAllowed("REQUEST_INSTALL_PACKAGES: allow; time=+2m ago\n")).toBe(true);
        expect(installPackagesAllowed("REQUEST_INSTALL_PACKAGES: allow\n")).toBe(true);
        expect(installPackagesAllowed("REQUEST_INSTALL_PACKAGES: default\n")).toBe(false);
        expect(installPackagesAllowed("No operations.\n")).toBe(false);
        expect(batteryWhitelisted("system-excidle,com.example.one,1000\r\nuser,app.polaris.tv,10123\r\n")).toBe(true);
        expect(batteryWhitelisted("user,app.polaris.tv.other,10124\n")).toBe(false);
        expect(batteryWhitelisted("")).toBe(false);
    });

    it("tries every level even when one throws or is refused, and reads before only where it is set", async () => {
        const ran: string[] = [];
        const answers: Record<string, string> = {
            "dumpsys package app.polaris.tv | grep -F WRITE_SECURE_SETTINGS": "android.permission.WRITE_SECURE_SETTINGS: granted=true\n",
            "dumpsys notification | grep -F GuardRevival": "",
            "appops get app.polaris.tv REQUEST_INSTALL_PACKAGES": "REQUEST_INSTALL_PACKAGES: allow\n",
            "dumpsys deviceidle whitelist": "user,app.polaris.tv,10123\n"
        };
        const adb = {
            shell: async (command: string) => {
                ran.push(command);
                if (command.startsWith("appops set")) throw new Error("refused");
                return answers[command] ?? "";
            }
        };
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await grantControl(adb, controlGrants(30))).toEqual([
            { rung: "secure-settings", state: "got" },
            { rung: "notification-listener", state: "refused" },
            { rung: "install-packages", state: "refused" },
            { rung: "battery", state: "got" }
        ]);
        error.mockRestore();
        expect(ran).not.toContain("settings get secure enabled_notification_listeners");
        expect(ran).not.toContain("appops get app.polaris.tv REQUEST_INSTALL_PACKAGES");
        expect(ran).toContain("dumpsys deviceidle whitelist +app.polaris.tv");

        ran.length = 0;
        answers["settings get secure enabled_notification_listeners"] = "cmd: Can't find service: settings";
        expect(await grantControl(adb, [grant("notification-listener", 23)])).toEqual([{ rung: "notification-listener", state: "refused" }]);
        expect(ran).toEqual(["settings get secure enabled_notification_listeners", "settings get secure enabled_notification_listeners"]);
    });

    it("reports Home as skipped where the TV keeps its own, and as got only when it was confirmed", () => {
        expect(homeControl(false, "installed")).toEqual({ rung: "home", state: "skipped" });
        expect(homeControl(true, "installed-home")).toEqual({ rung: "home", state: "got" });
        expect(homeControl(true, "installed-home-key")).toEqual({ rung: "home", state: "got" });
        expect(homeControl(true, "installed-home-refused")).toEqual({ rung: "home", state: "refused" });
        expect(homeControl(true, "installed-home-key-off")).toEqual({ rung: "home", state: "refused" });
    });
});

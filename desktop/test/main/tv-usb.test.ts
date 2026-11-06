/**
 * Installing on a TV over a USB cable: the WebUSB pipe against a fake device
 * that speaks adbd's USB framing - header and payload as separate transfers -
 * and checks the key the way a TV does, with the ADB client on top of it.
 */

import { describe, expect, it, vi } from "vitest";
import { constants, createPublicKey, publicDecrypt } from "node:crypto";
import { AdbConnection, androidPublicKey, encodePacket, newAdbKey, PacketReader, type AdbLinkOpener } from "../../src/main/adb-client";
import {
    adbInterface,
    describeDevices,
    openAdbPipe,
    UsbOpenError,
    type UsbConfigurationLike,
    type UsbDeviceLike,
    type UsbTransferInLike
} from "../../src/shared/usb-adb";

vi.mock("electron", () => ({
    app: { getPath: () => "" },
    BrowserWindow: class {},
    ipcMain: { handle: () => undefined, on: () => undefined },
    session: { fromPartition: () => ({}) }
}));
vi.mock("../../src/main/windows", () => ({ openLocalWindow: () => null }));

const { connectFailure, startTarget, targetLabel } = await import("../../src/main/tv-install");

const CNXN = 0x4e584e43;
const AUTH = 0x48545541;
const OPEN = 0x4e45504f;
const OKAY = 0x59414b4f;
const CLSE = 0x45534c43;
const WRTE = 0x45545257;
const KEY = newAdbKey();
const PACKET_SIZE = 512;

function adbConfiguration(): UsbConfigurationLike {
    return {
        configurationValue: 1,
        interfaces: [
            { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 0x08, interfaceSubclass: 6, interfaceProtocol: 0x50, endpoints: [] }] },
            {
                interfaceNumber: 1,
                alternates: [
                    {
                        alternateSetting: 0,
                        interfaceClass: 0xff,
                        interfaceSubclass: 0x42,
                        interfaceProtocol: 0x01,
                        endpoints: [
                            { endpointNumber: 1, direction: "in", type: "bulk", packetSize: PACKET_SIZE },
                            { endpointNumber: 2, direction: "out", type: "bulk", packetSize: PACKET_SIZE }
                        ]
                    }
                ]
            }
        ]
    };
}

interface FakeOptions {
    /** Whether the TV already trusts this computer's key. */
    readonly trusted: boolean;
    readonly claim?: () => Promise<void>;
}

/** A TV on the end of a cable: adbd's USB side, with a shell that answers `Success`. */
class FakeTv implements UsbDeviceLike {
    readonly vendorId = 0x18d1;
    readonly productId = 0x4ee7;
    readonly serialNumber = "ABC123\u0007";
    readonly manufacturerName = "Fake";
    readonly productName = "TV\n";
    configuration: UsbConfigurationLike | null = null;
    readonly configurations = [adbConfiguration()];
    readonly outs: number[] = [];
    readonly shells: string[] = [];
    prompted = false;
    private readonly queue: Uint8Array[] = [];
    private readers: Array<{ resolve: (one: UsbTransferInLike) => void; reject: (error: Error) => void; }> = [];
    private reader = new PacketReader();
    private header: Buffer | null = null;
    private token = Buffer.alloc(20, 5);

    constructor(private readonly options: FakeOptions) {}

    async open(): Promise<void> {}
    async close(): Promise<void> {}
    async selectConfiguration(value: number): Promise<void> {
        this.configuration = this.configurations.find((one) => one.configurationValue === value) ?? null;
    }
    async claimInterface(): Promise<void> {
        await this.options.claim?.();
    }
    async releaseInterface(): Promise<void> {}
    async selectAlternateInterface(): Promise<void> {}

    async transferIn(endpoint: number, length: number): Promise<UsbTransferInLike> {
        expect(endpoint).toBe(1);
        const next = this.queue.shift();
        const answer = (bytes: Uint8Array): UsbTransferInLike => {
            expect(bytes.length).toBeLessThanOrEqual(length);
            return { status: "ok", data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
        };
        if (next) return answer(next);
        return new Promise((resolve, reject) => this.readers.push({ resolve: (one) => resolve(one), reject })).then((one) =>
            answer(one as unknown as Uint8Array)
        );
    }

    /** Pulls the cable: every read under way fails as WebUSB's does. */
    unplug(): void {
        for (const reader of this.readers.splice(0)) reader.reject(Object.assign(new Error("gone"), { name: "NetworkError" }));
    }

    private reply(command: number, arg0: number, arg1: number, data = Buffer.alloc(0)): void {
        const packet = encodePacket(command, arg0, arg1, data);
        const parts = [packet.subarray(0, 24), packet.subarray(24)].filter((one) => one.length > 0);
        for (const part of parts) {
            const waiting = this.readers.shift();
            if (waiting) waiting.resolve(new Uint8Array(part) as unknown as UsbTransferInLike);
            else this.queue.push(new Uint8Array(part));
        }
    }

    async transferOut(endpoint: number, data: Uint8Array): Promise<unknown> {
        expect(endpoint).toBe(2);
        this.outs.push(data.length);
        if (data.length === 0) return {};
        // adbd reads the header, then the payload, as two transfers.
        if (!this.header) {
            expect(data.length).toBe(24);
            this.header = Buffer.from(data);
            if (this.header.readUInt32LE(12) > 0) return {};
        }
        const header = this.header;
        this.header = null;
        const bytes = header.readUInt32LE(12) > 0 ? Buffer.concat([header, Buffer.from(data)]) : header;
        for (const packet of this.reader.push(bytes)) this.handle(packet);
        return {};
    }

    private handle(packet: { command: number; arg0: number; arg1: number; data: Buffer; }): void {
        if (packet.command === CNXN) this.reply(AUTH, 1, 0, this.token);
        else if (packet.command === AUTH && packet.arg0 === 2) {
            const opened = publicDecrypt({ key: createPublicKey(KEY), padding: constants.RSA_PKCS1_PADDING }, packet.data);
            if (this.options.trusted && opened.subarray(-20).equals(this.token)) this.reply(CNXN, 0x01000000, 256 * 1024, Buffer.from("device::\0"));
            else this.reply(AUTH, 1, 0, this.token);
        } else if (packet.command === AUTH && packet.arg0 === 3) {
            expect(packet.data).toEqual(androidPublicKey(KEY));
            this.prompted = true;
            this.reply(CNXN, 0x01000000, 256 * 1024, Buffer.from("device::\0"));
        } else if (packet.command === OPEN) {
            this.shells.push(packet.data.toString().replace(/\0$/, ""));
            this.reply(OKAY, 77, packet.arg0);
            if (packet.data.toString().startsWith("shell:hang")) return;
            this.reply(WRTE, 77, packet.arg0, Buffer.from("Success\n"));
            this.reply(CLSE, 77, packet.arg0);
        }
    }
}

/** The same glue `usb-link.ts` gives the ADB client, without the hidden window. */
function linkTo(device: UsbDeviceLike): AdbLinkOpener {
    return async (events) => {
        const pipe = await openAdbPipe(
            device,
            (bytes) => events.data(Buffer.from(bytes)),
            () => events.lost(new Error("The TV closed the connection."))
        );
        return { send: (header, data) => pipe.send(header, data), close: () => void pipe.close() };
    };
}

function connection(device: UsbDeviceLike, onPrompt?: () => void): AdbConnection {
    return new AdbConnection({ link: linkTo(device), key: KEY, connectMs: 2_000, approveMs: 2_000, commandMs: 2_000, onPrompt });
}

describe("finding the TV on the cable", () => {
    it("picks the ADB interface and its bulk endpoints", () => {
        const found = adbInterface(new FakeTv({ trusted: true }));
        expect(found).toMatchObject({ configuration: 1, interfaceNumber: 1, alternate: 0 });
        expect(found?.in.endpointNumber).toBe(1);
        expect(found?.out.endpointNumber).toBe(2);
    });

    it("lists only devices that offer ADB, with no control characters in what is shown", () => {
        const tv = new FakeTv({ trusted: true });
        const stick = { ...tv, configurations: [{ configurationValue: 1, interfaces: [] }] } as unknown as UsbDeviceLike;
        const listed = describeDevices([stick, tv]);
        expect(listed.map((one) => one.info)).toEqual([{ id: "s:ABC123", name: "Fake TV" }]);
    });
});

describe("talking over the cable", () => {
    it("authenticates with a key the TV trusts and runs a command", async () => {
        const tv = new FakeTv({ trusted: true });
        const adb = connection(tv);
        await adb.open();
        expect(await adb.shell("getprop ro.build.version.sdk")).toBe("Success\n");
        expect(tv.prompted).toBe(false);
        adb.close();
    });

    it("sends the public key and waits for Allow on a TV that does not know it", async () => {
        const tv = new FakeTv({ trusted: false });
        const prompt = vi.fn();
        const adb = connection(tv, prompt);
        await adb.open();
        expect(prompt).toHaveBeenCalledOnce();
        expect(tv.prompted).toBe(true);
        adb.close();
    });

    it("ends a transfer that fills its last USB packet with an empty one", async () => {
        const tv = new FakeTv({ trusted: true });
        const adb = connection(tv);
        await adb.open();
        // 512 bytes of command plus "shell:" and the NUL: make the payload exactly 1024.
        await adb.shell("x".repeat(1024 - "shell:".length - 1));
        const at = tv.outs.indexOf(1024);
        expect(at).toBeGreaterThan(0);
        expect(tv.outs[at + 1]).toBe(0);
        expect(tv.outs.filter((one) => one === 0).length).toBe(1);
        adb.close();
    });

    it("fails what is under way when the cable is pulled", async () => {
        const tv = new FakeTv({ trusted: true });
        const adb = connection(tv);
        await adb.open();
        const pending = adb.shell("hang");
        await vi.waitFor(() => expect(tv.shells).toContain("shell:hang"));
        tv.unplug();
        await expect(pending).rejects.toThrow("The TV closed the connection.");
    });

    it("says busy when another program holds the interface, gone when it was unplugged", async () => {
        const held = new FakeTv({ trusted: true, claim: () => Promise.reject(Object.assign(new Error("x"), { name: "NetworkError" })) });
        await expect(openAdbPipe(held, () => undefined, () => undefined)).rejects.toEqual(new UsbOpenError("busy"));
        const gone = new FakeTv({ trusted: true, claim: () => Promise.reject(Object.assign(new Error("x"), { name: "NotFoundError" })) });
        await expect(openAdbPipe(gone, () => undefined, () => undefined)).rejects.toMatchObject({ reason: "gone" });
    });
});

describe("what the install window is told", () => {
    it("names the USB failures", () => {
        expect(connectFailure({ code: "USB_BUSY" })).toBe("usb-busy");
        expect(connectFailure({ code: "USB_GONE" })).toBe("usb-gone");
        expect(connectFailure({ code: "ECONNREFUSED" })).toBe("adb-off");
    });

    it("installs only on a USB TV that was listed", () => {
        const listed = [{ id: "s:ABC123" }];
        expect(startTarget({ usb: "s:ABC123", home: true }, listed)).toEqual({ kind: "usb", id: "s:ABC123" });
        expect(startTarget({ usb: "s:OTHER", home: true }, listed)).toBeNull();
        expect(startTarget({ usb: "s:ABC123", home: true }, null)).toBeNull();
        expect(startTarget({ host: "192.168.1.5", home: false }, null)).toEqual({ kind: "network", host: "192.168.1.5" });
    });

    it("keeps a USB id out of the backup path's separators", () => {
        expect(targetLabel({ kind: "usb", id: "s:../x\\y" })).toBe("usb-s----x-y");
    });
});

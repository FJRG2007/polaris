/**
 * Discovery by announcement: the query asks for every TV service, a response is
 * read through its compressed names, and what the TVs announce becomes the
 * sighting the path engine reads - so a pairing-only TV is known as one before
 * anything waits on a port it never opens.
 */

import { EventEmitter } from "node:events";
import { choosePath } from "@/main/tv-path";
import { createSocket, type Socket } from "node:dgram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    askTimes,
    browseWith,
    collectTvs,
    mergeFound,
    namesOf,
    parseMdns,
    RESEND_MS,
    sightingOf,
    tvQuery,
    TV_SERVICE_TYPES,
    type BrowseDeps
} from "@/main/tv-mdns";
import { ANDROID_TV_ADB, CHROMECAST_GOOGLE_TV, PRINTER, response } from "../fixtures/mdns";

describe("tvQuery", () => {
    it("asks for each TV service as a PTR question that wants a unicast answer", () => {
        const query = tvQuery();
        expect(query.readUInt16BE(2)).toBe(0);
        expect(query.readUInt16BE(4)).toBe(4);
        for (const type of Object.values(TV_SERVICE_TYPES)) {
            const encoded = Buffer.concat(type.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])));
            const at = query.indexOf(encoded);
            expect(at).toBeGreaterThan(0);
            const tail = at + encoded.length + 1;
            expect(query.readUInt16BE(tail)).toBe(12);
            expect(query.readUInt16BE(tail + 2)).toBe(0x8001);
        }
    });
});

describe("parseMdns", () => {
    it("reads PTR, TXT, SRV and A records through compressed names", () => {
        const records = parseMdns(CHROMECAST_GOOGLE_TV);
        expect(records).toContainEqual({
            name: "_googlecast._tcp.local",
            type: 12,
            data: "Chromecast-HD-0a1b2c3d4e5f._googlecast._tcp.local"
        });
        expect(records).toContainEqual({
            name: "adb-FIXTURE0001-AbCdEf._adb-tls-pairing._tcp.local",
            type: 33,
            data: "Android.local",
            port: 37215
        });
        expect(records).toContainEqual({ name: "Android.local", type: 1, data: "192.168.1.40" });
        const txt = records.find((record) => record.type === 16);
        expect(txt?.data).toContain("md=Chromecast HD");
    });

    it("reads a query, a truncated packet and a pointer loop as nothing", () => {
        expect(parseMdns(tvQuery())).toEqual([]);
        expect(parseMdns(CHROMECAST_GOOGLE_TV.subarray(0, 40))).toEqual([]);
        expect(parseMdns(Buffer.alloc(4))).toEqual([]);
        const loop = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 12]);
        expect(parseMdns(loop)).toEqual([]);
    });
});

describe("collectTvs", () => {
    it("knows a Chromecast with Google TV by its model, and as pairing-only", () => {
        const found = collectTvs([{ data: CHROMECAST_GOOGLE_TV, from: "192.168.1.40" }]);
        expect([...found.keys()]).toEqual(["192.168.1.40"]);
        const tv = found.get("192.168.1.40")!;
        expect(tv).toEqual({
            services: ["adb-tls-pairing", "googlecast"],
            castModel: "Chromecast HD",
            name: "Living Room TV",
            ports: { "adb-tls-pairing": 37215, googlecast: 8009 }
        });
        const path = choosePath(tv);
        expect(path.route).toBe("pairing");
        expect(path.reason).toBe("google-pairing");
    });

    it("takes the sender's address when no address record came, and sees classic network debugging", () => {
        const found = collectTvs([{ data: ANDROID_TV_ADB, from: "192.168.1.51" }]);
        const tv = found.get("192.168.1.51")!;
        expect(tv.services).toEqual(["adb"]);
        expect(tv.name).toBeNull();
        expect(choosePath(tv).route).toBe("network");
    });

    it("joins records that came in separate packets, and dedupes by address", () => {
        const ptr = response([{ name: "_googlecast._tcp.local", type: "PTR", target: "TV-1._googlecast._tcp.local" }]);
        const txt = response([{ name: "tv-1._googlecast._tcp.local", type: "TXT", entries: ["MD=BRAVIA 4K VH2"] }]);
        const adb = response([{ name: "_adb._tcp.local", type: "PTR", target: "adb-X._adb._tcp.local" }]);
        const found = collectTvs([
            { data: ptr, from: "10.0.0.7" },
            { data: txt, from: "10.0.0.7" },
            { data: adb, from: "10.0.0.7" }
        ]);
        expect(found.size).toBe(1);
        expect(found.get("10.0.0.7")).toEqual({ services: ["adb", "googlecast"], castModel: "BRAVIA 4K VH2", name: "BRAVIA 4K VH2", ports: {} });
    });

    it("ignores other services and public addresses", () => {
        expect(collectTvs([{ data: PRINTER, from: "192.168.1.9" }]).size).toBe(0);
        expect(collectTvs([{ data: ANDROID_TV_ADB, from: "8.8.8.8" }]).size).toBe(0);
    });
});

describe("merging what was found", () => {
    it("lists each address once, in numeric order, whether the port sweep or an announcement found it", () => {
        const heard = collectTvs([
            { data: CHROMECAST_GOOGLE_TV, from: "192.168.1.40" },
            { data: ANDROID_TV_ADB, from: "192.168.1.100" }
        ]);
        expect(mergeFound(["192.168.1.100", "192.168.1.9"], heard)).toEqual(["192.168.1.9", "192.168.1.40", "192.168.1.100"]);
        expect(namesOf(heard)).toEqual({ "192.168.1.40": "Living Room TV" });
    });

    it("gives the engine what the TV announced, so a pairing-only TV needs pairing before any wait", () => {
        const heard = collectTvs([{ data: CHROMECAST_GOOGLE_TV, from: "192.168.1.40" }]);
        expect(choosePath(sightingOf(heard.get("192.168.1.40"), false)).route).toBe("pairing");
        expect(choosePath(sightingOf(heard.get("192.168.1.40"), true)).route).toBe("network");
        expect(choosePath(sightingOf(undefined, false)).route).toBe("network");
    });
});

describe("asking without listening for the network", () => {
    class FakeSocket extends EventEmitter {
        readonly bound: { address?: string; port?: number; }[] = [];
        readonly sent: { at: number; port: number; address: string; }[] = [];
        readonly interfaces: string[] = [];
        readonly addMembership = vi.fn();
        closed = false;

        bind(options: { address?: string; port?: number; }, done: () => void): this {
            this.bound.push(options);
            queueMicrotask(done);
            return this;
        }

        setMulticastInterface(address: string): void {
            this.interfaces.push(address);
        }

        send(_data: Buffer, port: number, address: string): void {
            this.sent.push({ at: Date.now(), port, address });
        }

        close(): void {
            this.closed = true;
        }
    }

    function deps(locals: string[]) {
        const sockets: FakeSocket[] = [];
        const created: BrowseDeps = {
            locals: () => locals,
            createSocket: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket as unknown as Socket;
            }
        };
        return { created, sockets };
    }

    beforeEach(() => {
        vi.useFakeTimers({ now: 0 });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("binds each interface's own address on a port the system picks, never 5353 or the wildcard, and joins no group", async () => {
        const { created, sockets } = deps(["192.168.1.10", "10.0.0.5"]);
        const browsing = browseWith(created, 3_000);
        await vi.runAllTimersAsync();
        await browsing;
        expect(sockets.map((socket) => socket.bound)).toEqual([[{ address: "192.168.1.10", port: 0 }], [{ address: "10.0.0.5", port: 0 }]]);
        for (const socket of sockets) {
            expect(socket.bound[0]!.port).not.toBe(5353);
            expect(socket.bound[0]!.address).not.toBe("0.0.0.0");
            expect(socket.addMembership).not.toHaveBeenCalled();
            expect(socket.closed).toBe(true);
        }
        expect(sockets.map((socket) => socket.interfaces)).toEqual([["192.168.1.10"], ["10.0.0.5"]]);
    });

    it("sends the query to the group again before each 3-second window ends, for the whole listen", async () => {
        const { created, sockets } = deps(["192.168.1.10"]);
        const browsing = browseWith(created, 3_000);
        await vi.runAllTimersAsync();
        await browsing;
        const times = sockets[0]!.sent.map((send) => send.at);
        expect(times[0]).toBe(0);
        expect(sockets[0]!.sent.every((send) => send.port === 5353 && send.address === "224.0.0.251")).toBe(true);
        expect(times).toEqual([0, 1_000, 2_000]);
    });

    it("keeps the window open to the end of any listen time", () => {
        expect(RESEND_MS).toBeLessThan(3_000);
        for (const listen of [500, 1_500, 3_000, 10_000, 60_000]) {
            const times = askTimes(listen);
            expect(times[0]).toBe(0);
            for (let index = 1; index < times.length; index += 1) expect(times[index]! - times[index - 1]!).toBeLessThan(3_000);
            expect(times[times.length - 1]! + 3_000).toBeGreaterThanOrEqual(listen);
            expect(times[times.length - 1]!).toBeLessThan(listen);
        }
    });

    it("collects the unicast answers each socket hears", async () => {
        const { created, sockets } = deps(["192.168.1.10"]);
        const browsing = browseWith(created, 1_500);
        await vi.advanceTimersByTimeAsync(10);
        sockets[0]!.emit("message", CHROMECAST_GOOGLE_TV, { address: "192.168.1.40", port: 5353 });
        await vi.runAllTimersAsync();
        expect([...(await browsing).keys()]).toEqual(["192.168.1.40"]);
    });

    it("finds nothing, without throwing, when no interface can be bound", async () => {
        const failing: BrowseDeps = {
            locals: () => ["192.168.1.10"],
            createSocket: () => {
                const socket = new FakeSocket();
                socket.bind = function (this: FakeSocket) {
                    queueMicrotask(() => this.emit("error", new Error("EADDRNOTAVAIL")));
                    return this;
                };
                return socket as unknown as Socket;
            }
        };
        expect((await browseWith(failing, 1_000)).size).toBe(0);
        expect((await browseWith(deps([]).created, 1_000)).size).toBe(0);
    });

    it("binds a real socket off 5353 on the address it is given", async () => {
        vi.useRealTimers();
        const sockets: Socket[] = [];
        const real: BrowseDeps = {
            locals: () => ["127.0.0.1"],
            createSocket: (type) => {
                const socket = createSocket(type);
                sockets.push(socket);
                return socket;
            }
        };
        const browsing = browseWith(real, 200);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const address = sockets[0]!.address();
        expect(address.address).toBe("127.0.0.1");
        expect(address.port).not.toBe(5353);
        expect(address.port).toBeGreaterThan(0);
        await browsing;
    });
});

/**
 * Discovery by announcement: the query asks for every TV service, a response is
 * read through its compressed names, and what the TVs announce becomes the
 * sighting the path engine reads - so a pairing-only TV is known as one before
 * anything waits on a port it never opens.
 */

import { choosePath } from "@/main/tv-path";
import { describe, expect, it } from "vitest";
import { collectTvs, mergeFound, namesOf, parseMdns, sightingOf, tvQuery, TV_SERVICE_TYPES } from "@/main/tv-mdns";
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
            data: "Android.local"
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
            name: "Living Room TV"
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
        expect(found.get("10.0.0.7")).toEqual({ services: ["adb", "googlecast"], castModel: "BRAVIA 4K VH2", name: "BRAVIA 4K VH2" });
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

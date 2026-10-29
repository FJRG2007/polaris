/**
 * The servers this app keeps: read leniently, one entry per address, a new one
 * at the front, and the one in use marked.
 */

import { describe, expect, it } from "vitest";
import {
    describeServer,
    listServers,
    normalizeServerName,
    readServers,
    renameServer,
    SERVERS_MAX,
    withoutServer,
    withServer
} from "@/shared/servers";

const HOME = "https://polaris.example.com";
const WORK = "http://192.168.1.20:3000";

describe("the server list", () => {
    it("reads what was stored and leaves out what is not an address or repeats one", () => {
        expect(
            readServers([
                { origin: HOME, name: "  Home   lab " },
                { origin: "https://polaris.example.com/" },
                { origin: "not an address" },
                { origin: WORK, name: 7 },
                "junk"
            ])
        ).toEqual([
            { origin: HOME, name: "Home lab" },
            { origin: WORK, name: null }
        ]);
        expect(readServers(undefined)).toEqual([]);
        expect(readServers(Array.from({ length: 30 }, (_, i) => ({ origin: `https://p${i}.example.com` })))).toHaveLength(
            SERVERS_MAX
        );
    });

    it("adds a new server at the front and keeps a known one where it is", () => {
        const one = withServer([], HOME);
        const two = withServer(one, WORK);
        expect(two.map((s) => s.origin)).toEqual([WORK, HOME]);
        expect(withServer(two, HOME)).toEqual(two);
    });

    it("renames, removes, and marks the one in use", () => {
        const saved = renameServer(withServer(withServer([], HOME), WORK), WORK, normalizeServerName("Office"));
        const rows = listServers(saved, HOME);
        expect(rows.map((row) => [describeServer(row), row.active])).toEqual([
            ["Office", false],
            ["polaris.example.com", true]
        ]);
        expect(rows[0]!.host).toBe("192.168.1.20:3000");
        expect(withoutServer(saved, WORK).map((s) => s.origin)).toEqual([HOME]);
        expect(normalizeServerName("   ")).toBeNull();
    });
});

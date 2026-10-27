/**
 * The AAAA records: published only once a check from outside got in, withdrawn
 * only after several failed checks in a row, and never written over a record
 * that is not Polaris's own.
 */

import { describe, expect, it } from "vitest";
import {
    AAAA_FAILS_TO_REMOVE,
    canonicalIpv6,
    EMPTY_AAAA,
    nextAaaa,
    planAaaaRecords,
    type AaaaState
} from "../../src/lib/backup-access/aaaa";

// Fixture addresses from the documentation range, which counts as global here.
const HOME = "2001:db8:0:1::10";
const MOVED = "2001:db8:0:2::10";
const FOREIGN = "2001:db8:ffff::1";

describe("when the address is published", () => {
    it("publishes only after a check from outside got in", () => {
        expect(nextAaaa(EMPTY_AAAA, { ipv6: HOME, inbound: null }).published).toBeNull();
        expect(nextAaaa(EMPTY_AAAA, { ipv6: HOME, inbound: false }).published).toBeNull();
        const up = nextAaaa(EMPTY_AAAA, { ipv6: HOME, inbound: true });
        expect(up.published).toBe(HOME);
        expect(up.written).toEqual([HOME]);
    });

    it("never publishes a unique-local address", () => {
        expect(nextAaaa(EMPTY_AAAA, { ipv6: "fd00::1", inbound: true }).published).toBeNull();
    });

    it("keeps a published address through a few failed checks, then withdraws it", () => {
        let state: AaaaState = nextAaaa(EMPTY_AAAA, { ipv6: HOME, inbound: true });
        for (let fail = 1; fail < AAAA_FAILS_TO_REMOVE; fail += 1) {
            state = nextAaaa(state, { ipv6: HOME, inbound: false });
            expect(state.published).toBe(HOME);
        }
        state = nextAaaa(state, { ipv6: HOME, inbound: false });
        expect(state.published).toBeNull();
        expect(state.written).toEqual([HOME]);
    });

    it("does not count a pass that could not check", () => {
        let state = nextAaaa(EMPTY_AAAA, { ipv6: HOME, inbound: true });
        for (let pass = 0; pass < AAAA_FAILS_TO_REMOVE + 2; pass += 1)
            state = nextAaaa(state, { ipv6: HOME, inbound: null });
        expect(state.published).toBe(HOME);
        expect(state.fails).toBe(0);
    });

    it("moves to a new address as soon as it is reachable", () => {
        const first = nextAaaa(EMPTY_AAAA, { ipv6: HOME, inbound: true });
        const moved = nextAaaa(first, { ipv6: MOVED, inbound: true });
        expect(moved.published).toBe(MOVED);
        expect(moved.written).toEqual([MOVED, HOME]);
    });

    it("compares addresses however they are spelled", () => {
        expect(canonicalIpv6("2001:DB8:0:1:0:0:0:10")).toBe(HOME);
        expect(canonicalIpv6("not an address")).toBeNull();
        const state = nextAaaa(EMPTY_AAAA, { ipv6: "2001:db8:0:1:0:0:0:10", inbound: true });
        expect(state.published).toBe(HOME);
        expect(nextAaaa(state, { ipv6: "2001:db8:0:1:0:0:0:10", inbound: null })).toBe(state);
    });
});

const record = (id: string, type: string, content: string, proxied = false) => ({
    id,
    type,
    content,
    proxied
});

describe("the record writes", () => {
    it("creates the AAAA beside a plain A record", () => {
        expect(planAaaaRecords([record("a", "A", "52.0.0.1")], HOME, [HOME])).toEqual([
            { kind: "create", content: HOME }
        ]);
    });

    it("writes nothing when the record already holds the address", () => {
        expect(
            planAaaaRecords([record("x", "AAAA", "2001:DB8:0:1:0:0:0:10")], HOME, [HOME])
        ).toEqual([]);
    });

    it("repoints its own record and drops its own duplicates", () => {
        const ops = planAaaaRecords([record("x", "AAAA", HOME), record("y", "AAAA", HOME)], MOVED, [
            MOVED,
            HOME
        ]);
        expect(ops).toEqual([
            { kind: "delete", id: "y" },
            { kind: "repoint", id: "x", content: MOVED }
        ]);
    });

    it("never touches an AAAA it did not write", () => {
        expect(planAaaaRecords([record("f", "AAAA", FOREIGN)], HOME, [HOME])).toEqual([]);
        expect(planAaaaRecords([record("f", "AAAA", FOREIGN)], null, [HOME])).toEqual([]);
    });

    it("stays off a tunnel's CNAME and a proxied name, removing its own there", () => {
        expect(planAaaaRecords([record("c", "CNAME", "x.cfargotunnel.com")], HOME, [HOME])).toEqual(
            []
        );
        expect(
            planAaaaRecords([record("a", "A", "52.0.0.1", true), record("x", "AAAA", HOME)], HOME, [
                HOME
            ])
        ).toEqual([{ kind: "delete", id: "x" }]);
    });

    it("removes only its own records when the address is withdrawn", () => {
        expect(
            planAaaaRecords([record("x", "AAAA", HOME), record("f", "AAAA", FOREIGN)], null, [HOME])
        ).toEqual([{ kind: "delete", id: "x" }]);
    });
});

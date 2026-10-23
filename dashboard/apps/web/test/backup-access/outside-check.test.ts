import { describe, expect, it } from "vitest";
import { combineVerdicts, outsideScript, readOutside } from "../../src/lib/backup-access/outside-check";
import { decide, INITIAL_STATE, FAIL_TO_FLIP, type FlipState } from "../../src/lib/backup-access/decision";

describe("outsideScript", () => {
    it("checks the address on 443 with each tool in turn", () => {
        const script = outsideScript("203.0.113.7");
        expect(script).toContain("addr='203.0.113.7'");
        expect(script).toContain("'https://203.0.113.7:443/'");
        expect(script).toContain("nc -z");
        expect(script).toContain("/dev/tcp/");
    });

    it("brackets an IPv6 address in the URL", () => {
        expect(outsideScript("2001:db8::1")).toContain("'https://[2001:db8::1]:443/'");
    });

    it("refuses anything that is not an IP literal", () => {
        expect(() => outsideScript("example.com")).toThrow();
        expect(() => outsideScript("1.2.3.4'; rm -rf /; '")).toThrow();
        expect(() => outsideScript("203.0.113.7", 70000)).toThrow();
    });
});

describe("readOutside", () => {
    it("reads a timed curl connection as up, whatever TLS said", () => {
        expect(readOutside("banner\nPOLARIS_OUTSIDE curl 0 0.042318\n")).toEqual({ verdict: "up", ms: 42 });
        expect(readOutside("POLARIS_OUTSIDE curl 35 0.031\n")).toEqual({ verdict: "up", ms: 31 });
    });

    it("reads curl's could-not-connect and timeout as down", () => {
        expect(readOutside("POLARIS_OUTSIDE curl 7 0.000000")).toEqual({ verdict: "down", ms: null });
        expect(readOutside("POLARIS_OUTSIDE curl 28 0.000000")).toEqual({ verdict: "down", ms: null });
    });

    it("does not guess on curl codes that say nothing about the port", () => {
        expect(readOutside("POLARIS_OUTSIDE curl 6 0.000000")).toBeNull();
    });

    it("reads nc and bash by exit status", () => {
        expect(readOutside("POLARIS_OUTSIDE nc 0")).toEqual({ verdict: "up", ms: null });
        expect(readOutside("POLARIS_OUTSIDE bash 1")).toEqual({ verdict: "down", ms: null });
    });

    it("answers null with no tool or no marker", () => {
        expect(readOutside("POLARIS_OUTSIDE none")).toBeNull();
        expect(readOutside("")).toBeNull();
        expect(readOutside("curl 0 0.1")).toBeNull();
    });
});

describe("combineVerdicts", () => {
    it("lets the outside answer win over the inside check", () => {
        expect(combineVerdicts("up", { verdict: "down", ms: null })).toEqual({ verdict: "down", from: "outside" });
        expect(combineVerdicts("down", { verdict: "up", ms: 20 })).toEqual({ verdict: "up", from: "outside" });
        expect(combineVerdicts("unknown", { verdict: "down", ms: null })).toEqual({ verdict: "down", from: "outside" });
    });

    it("falls back to the inside check when outside could not be asked", () => {
        expect(combineVerdicts("down", null)).toEqual({ verdict: "down", from: "inside" });
        expect(combineVerdicts("unknown", null)).toEqual({ verdict: "unknown", from: "inside" });
    });

    it("keeps no uplink whatever outside says", () => {
        expect(combineVerdicts("no-uplink", { verdict: "up", ms: 10 })).toEqual({ verdict: "no-uplink", from: "inside" });
    });

    it("flips on a carrier-NAT line the inside check cannot see", () => {
        // Inside, the public address still matches the records; outside, 443 is shut.
        let state: FlipState = INITIAL_STATE;
        let move: string | null = null;
        const now = new Date("2026-10-24T10:00:00Z");
        for (let pass = 0; pass < FAIL_TO_FLIP; pass++) {
            const { verdict } = combineVerdicts("up", { verdict: "down", ms: null });
            const decision = decide(state, {
                mode: "automatic",
                manualOn: false,
                pathReady: true,
                verdict,
                now: new Date(now.getTime() + pass * 60_000)
            });
            state = decision.state;
            move = decision.move;
        }
        expect(move).toBe("to-backup");
        expect(state.serving).toBe("backup");
    });
});

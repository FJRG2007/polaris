/**
 * What the relay's log is turned into.
 *
 * Every line here was taken from a relay that was actually failing. The one that
 * matters is the first: a Tapo camera refusing the account answers `200` with an
 * empty body, so nothing in the response says anything went wrong, and the only
 * record of why is one line written for whoever wrote go2rtc.
 */

import { describe, expect, it } from "vitest";
import { UNEXPLAINED, explainRelayFailure, relaySaid } from "@/lib/home/relay-failure";

/** Exactly as the relay wrote it, from the camera this was built for. */
const REFUSED =
    '18:50:22.162 ERR github.com/AlexxIT/go2rtc/internal/mjpeg/mjpeg.go:82 > error="streams: 401 Unauthorized"';

describe("why a camera would not open", () => {
    it("says the password first, because that is what a refusal means", () => {
        // Written from the case it was diagnosed on, where the password really
        // was wrong and the app setting really was on: a message that leads with
        // the setting sends the reader to check something that is already right.
        const said = explainRelayFailure(REFUSED) ?? "";
        expect(said.startsWith("The camera refused the password.")).toBe(true);
        expect(said.indexOf("TP-Link account")).toBeLessThan(
            said.indexOf("Third-Party Compatibility")
        );
    });

    it("reads the same refusal however the relay worded it", () => {
        for (const line of [
            'ERR > error="authentication failed"',
            'ERR > error="401 Unauthorized"',
            'ERR > error="tapo: wrong password"'
        ]) {
            expect(explainRelayFailure(line)).toContain("Third-Party Compatibility");
        }
    });

    it("tells a camera that went quiet from one that said no", () => {
        const said = explainRelayFailure('ERR > error="dial tcp 192.168.1.150:8800: i/o timeout"');
        expect(said).toContain("stopped answering");
        expect(said).not.toContain("password");
    });

    it("reports the newest failure, not the one from an hour ago", () => {
        // A camera that failed one way and then another must not be reported as
        // the first: the reader is being sent to fix the wrong thing.
        const log = ['ERR > error="401 Unauthorized"', 'ERR > error="i/o timeout"'].join("\n");
        expect(explainRelayFailure(log)).toContain("stopped answering");
    });

    it("ignores everything in the log that is not a failure", () => {
        const log = ["INF > listen addr=:1984", "INF > streams: connected"].join("\n");
        expect(explainRelayFailure(log)).toBeNull();
    });
});

describe("a failure nothing recognises", () => {
    it("hands back the relay's own words rather than a shrug", () => {
        expect(relaySaid('ERR > error="something nobody has seen before"')).toBe(
            "something nobody has seen before"
        );
    });

    it("never hands back the camera password with them", () => {
        // The relay quotes the source it was given, and on this protocol the
        // source is the password.
        const said = relaySaid('ERR > error="dial tapo://hunter2@192.168.1.150: refused"');
        expect(said).toBe("dial tapo://***@192.168.1.150: refused");
        expect(said).not.toContain("hunter2");
    });

    it("says nothing about a log with no failure in it", () => {
        expect(relaySaid("INF > all good")).toBeNull();
    });
});

describe("a relay too old to have a log to read", () => {
    it("still names the two causes rather than describing the silence", () => {
        // An installed relay predates the path being allowed and answers 404 for
        // it. That must not be the reader's problem.
        expect(UNEXPLAINED).toContain("Third-Party Compatibility");
        expect(UNEXPLAINED).toContain("sleep");
    });
});

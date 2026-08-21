/**
 * What a mount helper says, and what it means.
 *
 * Every string here came off a real deploy log. The one that prompted this is
 * the third: a NAS that had been switched off reported "Server abruptly closed
 * the connection", which reads like an SMB version argument or a rejected
 * password - and that is where the afternoon went. The machine was simply not
 * there.
 *
 * The original is always kept, because the translation is for the person
 * reading the log and the original is for whoever has to search for it.
 */

import { describe, expect, it } from "vitest";
import { mountFailureReason } from "../src/mount-failure.js";

const SHARE = "//192.168.1.145/Personal-Drive";

describe("what a failed mount means", () => {
    it("says a machine that is not there is not there", () => {
        const said = mountFailureReason(SHARE, "mount error: Server abruptly closed the connection.");
        expect(said).toContain("is not answering");
        expect(said).toContain(SHARE);
        // And the original survives, for searching.
        expect(said).toContain("Server abruptly closed the connection");
    });

    it("reads every shape of unreachable the same way", () => {
        for (const raw of [
            "mount error(112): Host is down",
            "connect EHOSTUNREACH 192.168.1.145:445",
            "mount error(113): No route to host",
            "connect ETIMEDOUT",
            "Connection refused",
            "could not resolve address for nas.local"
        ]) {
            expect(mountFailureReason(SHARE, raw)).toContain("is not answering");
        }
    });

    it("keeps a rejected credential apart, because that one is fixable here", () => {
        expect(mountFailureReason(SHARE, "mount error(13): Permission denied")).toContain(
            "refused the username or password"
        );
        expect(mountFailureReason(SHARE, "Status code: NT_STATUS_LOGON_FAILURE")).toContain(
            "refused the username or password"
        );
    });

    it("calls a share name that does not exist what it is", () => {
        expect(mountFailureReason(SHARE, "Status code: NT_STATUS_BAD_NETWORK_NAME")).toContain("not a share");
    });

    it("names a mount left behind by a connection that died", () => {
        expect(mountFailureReason(SHARE, "mount error(16): Device or resource busy")).toContain(
            "held by a connection that has died"
        );
    });

    it("passes anything it does not recognize through untouched", () => {
        // Guessing at an unknown message is how a log starts lying. The words
        // the helper chose are better than a wrong translation of them.
        expect(mountFailureReason(SHARE, "mount error(255): something new")).toBe(
            `could not mount ${SHARE}: mount error(255): something new`
        );
    });

    it("still says something when the failure said nothing at all", () => {
        expect(mountFailureReason(SHARE, "   ")).toBe(`${SHARE} could not be mounted.`);
    });
});

/**
 * What a storage failure is allowed to say.
 *
 * Two rules pull against each other here. A person who was given one folder on
 * somebody else's NAS may not be told the host, the share or the path behind it.
 * And a person on a deployment where nobody opens a terminal, given "Could not
 * list this location" and nothing else, has nowhere left to go. The classifier
 * is what settles it: the kind of failure is public, the device's own words are
 * not, and every branch here is one somebody would do something different about.
 */

import { describe, expect, it } from "vitest";
import { storageFailure, storageFailureDetail } from "../src/storage-failure.js";

/** An error in the shape a driver actually throws: a code, and a message that
 *  names the thing nobody outside may read. */
function thrown(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

describe("storageFailure", () => {
    it("tells a folder that is gone from a device that is gone", () => {
        expect(storageFailure(thrown("ENOENT", "no such file")).retryable).toBe(false);
        expect(storageFailure(thrown("ETIMEDOUT", "connect timed out")).retryable).toBe(true);
    });

    it("separates a refused sign-in from a refused folder", () => {
        const login = storageFailure(thrown("STATUS_LOGON_FAILURE", "smb: logon failure"));
        const denied = storageFailure(thrown("EACCES", "permission denied"));
        expect(login.reason).toContain("sign-in");
        expect(login.hint).toContain("credentials");
        expect(denied.reason).toContain("not allowed");
        expect(denied.reason).not.toBe(login.reason);
    });

    // A mount whose session died answers this, and it is the one failure that is
    // usually over by the time somebody clicks: the retry is the whole fix.
    it("offers a retry for a link that dropped", () => {
        const failure = storageFailure(thrown("ESTALE", "stale file handle"));
        expect(failure.retryable).toBe(true);
        expect(failure.reason).toContain("dropped");
    });

    it("reads a code the driver wrapped rather than threw", () => {
        const inner = thrown("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.4:445");
        const outer = Object.assign(new Error("list failed"), { cause: inner });
        expect(storageFailure(outer).reason).toBe(storageFailure(inner).reason);
    });

    it("says something general, and never the driver's words, for a cause it does not know", () => {
        const failure = storageFailure(thrown("EWHATEVER", "//nas.example.internal/private failed"));
        expect(failure.reason).toBe("Polaris could not read this folder.");
        expect(failure.reason).not.toContain("nas.example.internal");
        expect(failure.retryable).toBe(true);
    });

    // What a driver in this repo actually throws: its own code, its own sentence,
    // and the server's words underneath. `/root` and `/lost+found` on an enrolled
    // machine are the live case - folders the connection's account may not read,
    // which used to arrive as "not found" and read as "could not list".
    it("reads a StorageError by its code and its cause", () => {
        const denied = Object.assign(new Error("Not permitted: root"), {
            name: "StorageError",
            code: "permission_denied",
            cause: Object.assign(new Error("Permission denied"), { code: 3 })
        });
        expect(storageFailure(denied).reason).toContain("not allowed");
        expect(storageFailure(denied).retryable).toBe(false);

        const gone = Object.assign(new Error("Not found: list old"), {
            name: "StorageError",
            code: "not_found"
        });
        expect(storageFailure(gone).reason).toContain("not there");

        const dropped = Object.assign(new Error("SMB connection failed: socket closed"), {
            name: "StorageError",
            code: "connection_failed"
        });
        expect(storageFailure(dropped).retryable).toBe(true);
    });

    it("answers for something that is not an error at all", () => {
        for (const value of [null, undefined, 42, {}, "boom"]) {
            expect(storageFailure(value).reason).toBeTruthy();
        }
    });
});

describe("storageFailureDetail", () => {
    // The detail is the half the route only hands to somebody who administers the
    // connection, so what matters here is that it is bounded and one line.
    it("keeps the device's words, bounded and on one line", () => {
        const detail = storageFailureDetail(thrown("EACCES", `denied\n  at ${"x".repeat(600)}`));
        expect(detail?.length).toBeLessThanOrEqual(400);
        expect(detail).not.toContain("\n");
        expect(detail).toContain("EACCES");
    });

    it("is null when there was nothing to say", () => {
        expect(storageFailureDetail(null)).toBeNull();
        expect(storageFailureDetail(new Error(""))).toBeNull();
    });
});

import { describe, expect, it } from "vitest";
import { classifySshFailure } from "../src/client.js";

/** A socket error as Node raises it: a message plus a `code`. */
function socketError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

// What a terminal says when it cannot open a shell. "Disconnected" was all a
// reader got for a server recorded at an address it had left, which is the one
// failure here the product can repair.
describe("classifySshFailure", () => {
    it("reads nothing answering as unreachable", () => {
        expect(
            classifySshFailure(socketError("EHOSTUNREACH", "connect EHOSTUNREACH 192.0.2.10:22"))
        ).toBe("unreachable");
        expect(classifySshFailure(socketError("ECONNREFUSED", "connect ECONNREFUSED"))).toBe(
            "unreachable"
        );
        expect(classifySshFailure(new Error("Timed out while waiting for handshake"))).toBe(
            "unreachable"
        );
    });

    it("does not read something that answered and then hung up as unreachable", () => {
        expect(classifySshFailure(socketError("ECONNRESET", "read ECONNRESET"))).toBe("other");
        expect(
            classifySshFailure(
                Object.assign(new Error("Timed out while waiting for handshake"), { answered: true })
            )
        ).toBe("other");
        expect(
            classifySshFailure(
                Object.assign(socketError("ETIMEDOUT", "read ETIMEDOUT"), { answered: true })
            )
        ).toBe("other");
    });

    it("reads a key that is not the pinned one as identity", () => {
        expect(classifySshFailure(new Error("Host denied (verification failed)"))).toBe("identity");
    });

    it("reads a refused login as login", () => {
        expect(classifySshFailure(new Error("All configured authentication methods failed"))).toBe(
            "login"
        );
    });

    it("leaves anything else as other", () => {
        expect(classifySshFailure(new Error("Channel open failure"))).toBe("other");
        expect(classifySshFailure(null)).toBe("other");
    });
});

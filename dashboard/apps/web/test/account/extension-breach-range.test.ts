/**
 * The bucket of breached hashes the extension asks this deployment for.
 *
 * The extension warns somebody that the password they are inventing is already
 * public, and it cannot ask the corpus itself: its manifest declares no host
 * permission at all, so the only origin it may reach is the Polaris it belongs
 * to. This route is that hop, and two things about it are worth pinning.
 *
 * The first is what may arrive: five hexadecimal characters and nothing longer.
 * That bound is the k-anonymity model - one bucket in a million, identifying
 * nobody - and a path that accepted more would be a path a whole hash could be
 * sent to.
 *
 * The second is what an outage answers. An unreachable corpus must not come back
 * as an empty range, because an empty range reads as "this password is fine" and
 * would turn somebody else's downtime into a breached password quietly approved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const pwnedRange = vi.fn();

vi.mock("@/lib/pwned-passwords", () => ({ pwnedRange }));

const route = await import("../../src/app/api/polaris/pwned/[prefix]/route");

/** The route's own way of being called, with the params Next hands it. */
async function ask(prefix: string): Promise<Response> {
    return route.GET(new Request(`https://polaris.example/api/polaris/pwned/${prefix}`), {
        params: Promise.resolve({ prefix })
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    pwnedRange.mockResolvedValue("0011223344556677889900AABBCCDDEEFF00112:5\r\n");
});

describe("the breached-password range", () => {
    it("answers with the bucket, as text", async () => {
        const response = await ask("5BAA6");

        expect(response.status).toBe(200);
        expect(await response.text()).toContain(":5");
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(pwnedRange).toHaveBeenCalledWith("5BAA6");
    });

    it("asks the corpus in the case it is indexed by", async () => {
        await ask("5baa6");
        expect(pwnedRange).toHaveBeenCalledWith("5BAA6");
    });

    it("refuses anything that is not five characters of a hash", async () => {
        // The bound is the privacy model, not tidiness: a longer value is a
        // narrower bucket, and a whole hash is the password itself.
        for (const prefix of ["5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8", "5BAA", "ZZZZZ", ""]) {
            expect((await ask(prefix)).status).toBe(400);
        }
        expect(pwnedRange).not.toHaveBeenCalled();
    });

    it("says it could not be reached rather than answering with nothing", async () => {
        pwnedRange.mockResolvedValue(null);
        const response = await ask("5BAA6");

        expect(response.status).toBe(503);
        // An empty 200 is the dangerous answer: the extension would read it as a
        // password that appears in no breach.
        expect(await response.text()).not.toBe("");
    });
});

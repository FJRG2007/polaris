/**
 * Recognising the same browser after it has updated itself.
 *
 * The register that decides whether a device is new to an account keyed on the
 * raw user-agent, and a browser writes a new version into that string every few
 * weeks on its own. So the owner, on the machine they had used for a year, was
 * told their device was new - and told it again after the next update, for as
 * long as the setting stayed on.
 *
 * What the fingerprint must do is therefore both halves: survive a version, and
 * not survive anything else. The second half is what stops it becoming "any
 * Chrome on any Windows", which would hand a stranger's browser the standing of
 * the owner's.
 */

import { describe, expect, it } from "vitest";
import { deviceFingerprint } from "./user-agent.js";

const CHROME_131 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36";
const CHROME_132 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.83 Safari/537.36";

describe("the same browser after an update", () => {
    it("reads as the same device", () => {
        expect(deviceFingerprint(CHROME_131)).toBe(deviceFingerprint(CHROME_132));
    });

    it("keeps everything that is not a version", () => {
        // The point of taking only the versions: what is left still describes
        // the machine, so it can still tell one from another.
        expect(deviceFingerprint(CHROME_131)).toContain("Windows NT 10.0; Win64; x64");
    });
});

describe("a different device", () => {
    it("is not the same on a different system", () => {
        const mac =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36";
        expect(deviceFingerprint(mac)).not.toBe(deviceFingerprint(CHROME_131));
    });

    it("is not the same on a different architecture", () => {
        const arm =
            "Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36";
        expect(deviceFingerprint(arm)).not.toBe(deviceFingerprint(CHROME_131));
    });

    it("is not the same browser on the same machine", () => {
        // A rebadged Chromium carries its own token, which is exactly the kind
        // of thing that has to survive.
        const edge = `${CHROME_131} Edg/131.0.2903.63`;
        expect(deviceFingerprint(edge)).not.toBe(deviceFingerprint(CHROME_131));
    });

    it("is not the same on a phone claiming the same browser", () => {
        const phone =
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Mobile Safari/537.36";
        expect(deviceFingerprint(phone)).not.toBe(deviceFingerprint(CHROME_131));
    });
});

describe("a browser that said nothing", () => {
    it("fingerprints as nothing rather than as everything", () => {
        // Whatever asks this treats an empty answer as "cannot be placed"; a
        // value that collided with a real device would be far worse.
        expect(deviceFingerprint(null)).toBe("");
        expect(deviceFingerprint(undefined)).toBe("");
        expect(deviceFingerprint("   ")).toBe("");
    });
});

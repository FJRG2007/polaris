/**
 * What a stored mail body window means.
 *
 * The one behaviour worth pinning is that nothing here throws. This value is
 * read inside a sync pass, so a setting somebody typed badly - or a row written
 * by an older version, or by hand - must fall back rather than take the pass
 * down with it: mail failing to arrive is a far worse outcome than a window of
 * the wrong size.
 *
 * The ceiling is the other half. This number is spent on a disk that fills
 * quietly, so a typo of one zero too many has to be caught here rather than
 * discovered weeks later.
 */

import { describe, expect, it } from "vitest";
import {
    mailBodyKeep,
    MAIL_BODY_KEEP_MAX,
    MAIL_BODY_KEEP_DEFAULT
} from "../src/mail-body-window.js";

describe("the stored window", () => {
    it("is the default when nothing is stored", () => {
        expect(mailBodyKeep(null)).toBe(MAIL_BODY_KEEP_DEFAULT);
        expect(mailBodyKeep(undefined)).toBe(MAIL_BODY_KEEP_DEFAULT);
        expect(mailBodyKeep("")).toBe(MAIL_BODY_KEEP_DEFAULT);
        expect(mailBodyKeep("   ")).toBe(MAIL_BODY_KEEP_DEFAULT);
    });

    it("is the number when it is one", () => {
        expect(mailBodyKeep("120")).toBe(120);
        expect(mailBodyKeep(String(MAIL_BODY_KEEP_MAX))).toBe(MAIL_BODY_KEEP_MAX);
    });

    it("honours zero, which is the operator saying to hold nothing ahead of time", () => {
        // Not falsy-coerced back to the default: zero is an answer, and it is the
        // answer for a deployment whose mail server is on the same LAN.
        expect(mailBodyKeep("0")).toBe(0);
    });

    it("clamps above the ceiling rather than believing a typo", () => {
        expect(mailBodyKeep(String(MAIL_BODY_KEEP_MAX * 10))).toBe(MAIL_BODY_KEEP_MAX);
    });

    it("falls back rather than throwing on anything that is not a count", () => {
        for (const junk of ["-1", "lots", "NaN", "{}", "1e9999", "Infinity"]) {
            expect(() => mailBodyKeep(junk)).not.toThrow();
            expect(mailBodyKeep(junk)).toBeGreaterThanOrEqual(0);
            expect(mailBodyKeep(junk)).toBeLessThanOrEqual(MAIL_BODY_KEEP_MAX);
        }
        expect(mailBodyKeep("-1")).toBe(MAIL_BODY_KEEP_DEFAULT);
        expect(mailBodyKeep("lots")).toBe(MAIL_BODY_KEEP_DEFAULT);
    });
});

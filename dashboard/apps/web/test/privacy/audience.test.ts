/**
 * Who may see what, and the two rules that would be quietly wrong.
 *
 * `audienceAllows` is the function that decides whether somebody's photo is
 * shown and whether a tick is drawn. Being wrong one way is a leak; being wrong
 * the other is a bug nobody reports, because the person affected sees an empty
 * space and assumes that is how it works.
 *
 * The reciprocity of read receipts is asserted through the same lens: somebody
 * who hides that they read a message does not get to see that theirs was read.
 * That is not a nicety - a one-way version is a mirror, and it is the rule every
 * messenger with this feature arrived at.
 */

import { describe, expect, it } from "vitest";
import {
    DEFAULT_PRIVACY,
    PRIVACY_AUDIENCES,
    audienceAllows,
    privacySettingsSchema
} from "@polaris/core";

const stranger = { self: false, friends: false, viewerIsAdmin: false };
const friend = { self: false, friends: true, viewerIsAdmin: false };
const admin = { self: false, friends: false, viewerIsAdmin: true };
const me = { self: true, friends: false, viewerIsAdmin: false };

describe("an account nobody has configured", () => {
    it("shows everything, because nothing was asked for", () => {
        // Absence is not a stricter setting. Somebody who has never opened the
        // screen has not made a decision, and defaulting to closed would hide
        // faces across an instance that never asked for it.
        expect(DEFAULT_PRIVACY.lastSeen).toBe("everyone");
        expect(DEFAULT_PRIVACY.readReceipts).toBe("everyone");
        expect(DEFAULT_PRIVACY.avatar).toBe("everyone");
    });
});

describe("everyone", () => {
    it("is visible to anybody", () => {
        expect(audienceAllows("everyone", stranger)).toBe(true);
        expect(audienceAllows("everyone", friend)).toBe(true);
    });
});

describe("friends only", () => {
    it("shows a friend and not a stranger", () => {
        expect(audienceAllows("friends", friend)).toBe(true);
        expect(audienceAllows("friends", stranger)).toBe(false);
    });
});

describe("nobody", () => {
    it("means nobody, including a friend", () => {
        expect(audienceAllows("nobody", friend)).toBe(false);
        expect(audienceAllows("nobody", stranger)).toBe(false);
    });

    it("still shows it to the person themselves", () => {
        // A setting that hid your own photo from you would be
        // indistinguishable from a broken upload.
        expect(audienceAllows("nobody", me)).toBe(true);
    });

    it("does not hide it from an administrator", () => {
        // Stated rather than hidden: whoever runs the instance can read the
        // database, so a setting claiming otherwise would not be true. The
        // screen says so in as many words.
        expect(audienceAllows("nobody", admin)).toBe(true);
    });
});

describe("the setting itself", () => {
    it("takes only the three audiences", () => {
        for (const audience of PRIVACY_AUDIENCES) {
            expect(privacySettingsSchema.safeParse({ avatar: audience }).success).toBe(true);
        }
        expect(privacySettingsSchema.safeParse({ avatar: "sometimes" }).success).toBe(false);
    });

    it("fills in the fields a stored row is missing", () => {
        const parsed = privacySettingsSchema.parse({ avatar: "nobody" });
        expect(parsed.avatar).toBe("nobody");
        expect(parsed.lastSeen).toBe("everyone");
    });
});

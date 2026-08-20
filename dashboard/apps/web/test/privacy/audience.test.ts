/**
 * Who may see what, and the rules that would be quietly wrong.
 *
 * `audienceAllows` is the function that decides whether somebody's photo is
 * shown, whether an address is drawn beside a name and whether a tick appears.
 * Being wrong one way is a leak; being wrong the other is a bug nobody reports,
 * because the person affected sees an empty space and assumes that is how it
 * works.
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
    PRIVACY_FIELDS,
    PRIVACY_FIELD_LABELS,
    PRIVACY_FIELD_NOTES,
    PRIVACY_SECTIONS,
    audienceAllows,
    audienceNeedsList,
    privacySettingsSchema,
    storedAudience
} from "@polaris/core";

const stranger = { self: false, friends: false, viewerIsAdmin: false };
const friend = { self: false, friends: true, viewerIsAdmin: false };
const admin = { self: false, friends: false, viewerIsAdmin: true };
const me = { self: true, friends: false, viewerIsAdmin: false };
const listed = { ...stranger, inList: true };

describe("an account nobody has configured", () => {
    it("shows what is not a way to reach them", () => {
        // Absence is not a stricter setting. Somebody who has never opened the
        // screen has not made a decision, and defaulting to closed would hide
        // faces across an instance that never asked for it.
        expect(DEFAULT_PRIVACY.lastSeen.audience).toBe("everyone");
        expect(DEFAULT_PRIVACY.readReceipts.audience).toBe("everyone");
        expect(DEFAULT_PRIVACY.avatar.audience).toBe("everyone");
    });

    it("lets the photo be opened, as its own question", () => {
        // Two decisions, not one: being recognisable in a list of names is what
        // a photo is for, and it is not the same as offering your face to be
        // studied. Both start open, and shutting the second must leave the first
        // alone - otherwise saying "do not open it" would take the face off
        // every screen.
        expect(DEFAULT_PRIVACY.photoFullSize.audience).toBe("everyone");
        const shut = privacySettingsSchema.parse({ photoFullSize: { audience: "nobody" } });
        expect(shut.photoFullSize.audience).toBe("nobody");
        expect(shut.avatar.audience).toBe("everyone");
    });

    it("keeps the address, the number and the name on the account to itself", () => {
        // The three exceptions, and the reason they are exceptions: an address
        // and a number are not details of a presence, they are what spam,
        // password resets and impersonation start from. The name on the account
        // is the third and the reason an account has a display name at all - the
        // chosen one is what every screen draws, and the one behind it is an
        // ordinary personal detail. Nothing in Polaris needs any of them to name
        // somebody or write to them.
        expect(DEFAULT_PRIVACY.email.audience).toBe("nobody");
        expect(DEFAULT_PRIVACY.phone.audience).toBe("nobody");
        expect(DEFAULT_PRIVACY.fullName.audience).toBe("nobody");
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

describe("the audiences that name people", () => {
    it("lets everybody but the named ones through", () => {
        expect(audienceAllows("everyoneExcept", stranger)).toBe(true);
        expect(audienceAllows("everyoneExcept", listed)).toBe(false);
    });

    it("narrows friends further still", () => {
        expect(audienceAllows("friendsExcept", friend)).toBe(true);
        expect(audienceAllows("friendsExcept", { ...friend, inList: true })).toBe(false);
        // Not a friend is still not a friend, listed or not.
        expect(audienceAllows("friendsExcept", listed)).toBe(false);
    });

    it("shows it to the named ones and nobody else", () => {
        expect(audienceAllows("only", listed)).toBe(true);
        expect(audienceAllows("only", stranger)).toBe(false);
        expect(audienceAllows("only", friend)).toBe(false);
    });

    it("shows nothing when the rule names a list that is gone", () => {
        // No list means nobody is on it, so "only" shuts. The opposite reading -
        // treating a missing list as no exceptions - would turn deleting a list
        // into a disclosure.
        expect(audienceAllows("only", stranger)).toBe(false);
    });

    it("says which of them are incomplete without one", () => {
        expect(PRIVACY_AUDIENCES.filter(audienceNeedsList)).toEqual([
            "everyoneExcept",
            "friendsExcept",
            "only"
        ]);
    });
});

describe("the setting itself", () => {
    it("takes every audience there is, and nothing else", () => {
        for (const audience of PRIVACY_AUDIENCES) {
            expect(privacySettingsSchema.safeParse({ avatar: { audience } }).success).toBe(true);
        }
        expect(privacySettingsSchema.safeParse({ avatar: { audience: "sometimes" } }).success).toBe(
            false
        );
    });

    it("fills in the fields a stored row is missing", () => {
        const parsed = privacySettingsSchema.parse({ avatar: { audience: "nobody" } });
        expect(parsed.avatar.audience).toBe("nobody");
        expect(parsed.avatar.people).toEqual([]);
        expect(parsed.lastSeen.audience).toBe("everyone");
    });

    it("keeps a field's own default when the rule is there and the audience is not", () => {
        // The trap this exists for: a default on the whole rule only fires when
        // the rule is missing. A row with nothing stored for a field parses to
        // `{ audience: undefined }` - a rule that IS there - so the default that
        // decides is the one on the audience itself. Get that wrong and every
        // setting that arrives shut arrives open instead.
        const parsed = privacySettingsSchema.parse({
            email: { audience: undefined },
            phone: {},
            avatar: {}
        });
        expect(parsed.email.audience).toBe("nobody");
        expect(parsed.phone.audience).toBe("nobody");
        expect(parsed.avatar.audience).toBe("everyone");
    });

    it("reads a stored value through the field it belongs to", () => {
        expect(storedAudience("email", "friends")).toBe("friends");
        // Nothing stored, and nothing anybody recognises, both fall to what the
        // field itself starts at - never to something more open.
        expect(storedAudience("email", undefined)).toBe("nobody");
        expect(storedAudience("phone", "sometimes")).toBe("nobody");
        expect(storedAudience("avatar", undefined)).toBe("everyone");
    });
});

describe("the screen's own list", () => {
    it("is every setting there is, and no more", () => {
        // The screen reads this rather than keeping an order of its own, so a
        // setting added to the schema and forgotten here would be a setting
        // nobody could reach.
        expect([...PRIVACY_FIELDS].sort()).toEqual(Object.keys(privacySettingsSchema.shape).sort());
    });

    it("says what each one is and what it does", () => {
        for (const field of PRIVACY_FIELDS) {
            expect(PRIVACY_FIELD_LABELS[field]).toBeTruthy();
            expect(PRIVACY_FIELD_NOTES[field]).toBeTruthy();
        }
    });

    it("puts each setting under exactly one heading", () => {
        // A setting in no section is a setting the screen never draws, and one
        // in two is a setting with two controls that disagree.
        const grouped = PRIVACY_SECTIONS.flatMap((section) => section.fields);
        expect([...grouped].sort()).toEqual([...PRIVACY_FIELDS].sort());
    });
});

describe("passing a message on", () => {
    it("is allowed until somebody says otherwise", () => {
        // A messenger where nothing can be forwarded is not what anybody
        // expects, so the default is the open one like every other audience
        // here.
        expect(DEFAULT_PRIVACY.forwarding.audience).toBe("everyone");
    });
});

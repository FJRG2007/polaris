/**
 * Who may play a sound, decided without a database.
 *
 * The soundboard is on for everybody until a switch or a denial says
 * otherwise. A denial of a person, of the space's role they hold or of their
 * organization role beats everything - except for the space's owner, who
 * decides the denials. The reasons come out in the order a reader would want
 * them: what nobody here can change first, their own controls last.
 */

import { describe, expect, it } from "vitest";
import * as rules from "@/lib/chat/soundboard";

const ADA = "0193b0f0-0000-7000-8000-0000000000a1";
const BEN = "0193b0f0-0000-7000-8000-0000000000b2";

const facts = (overrides: Partial<rules.SoundboardFacts> = {}): rules.SoundboardFacts => ({
    guest: false,
    standalone: false,
    space: { enabled: true, external: true },
    channelEnabled: true,
    denied: false,
    muted: false,
    deafened: false,
    serverMuted: false,
    serverDeafened: false,
    ...overrides
});

describe("a denial", () => {
    const member = { userId: ADA, spaceRole: "member" as const, orgRole: null };

    it("of nobody leaves everybody allowed", () => {
        expect(rules.soundboardDenied([], member)).toBe(false);
    });

    it("of one person names that person only", () => {
        const denials: rules.SoundDenial[] = [{ kind: "user", subject: ADA }];
        expect(rules.soundboardDenied(denials, member)).toBe(true);
        expect(rules.soundboardDenied(denials, { ...member, userId: BEN })).toBe(false);
    });

    it("of `member` reaches administrators too, since they are members", () => {
        const denials: rules.SoundDenial[] = [{ kind: "role", subject: "member" }];
        expect(rules.soundboardDenied(denials, { ...member, spaceRole: "admin" })).toBe(true);
    });

    it("of `admin` leaves plain members alone", () => {
        const denials: rules.SoundDenial[] = [{ kind: "role", subject: "admin" }];
        expect(rules.soundboardDenied(denials, member)).toBe(false);
        expect(rules.soundboardDenied(denials, { ...member, spaceRole: "admin" })).toBe(true);
    });

    it("of an organization role reaches whoever holds it, and is not the space's role of the same name", () => {
        const denials: rules.SoundDenial[] = [{ kind: "role", subject: "org:admin" }];
        expect(rules.soundboardDenied(denials, { ...member, orgRole: "admin" })).toBe(true);
        expect(rules.soundboardDenied(denials, { ...member, spaceRole: "admin" })).toBe(false);
    });

    it("beats every allow an admin role would otherwise give", () => {
        const denials: rules.SoundDenial[] = [{ kind: "user", subject: ADA }];
        expect(
            rules.soundboardDenied(denials, { ...member, spaceRole: "admin", orgRole: "owner" })
        ).toBe(true);
    });

    it("never reaches the space's owner", () => {
        const denials: rules.SoundDenial[] = [
            { kind: "user", subject: ADA },
            { kind: "role", subject: "member" }
        ];
        expect(rules.soundboardDenied(denials, { ...member, spaceRole: "owner" })).toBe(false);
    });

    it("is validated: a role is one of the two, or an organization's slug", () => {
        const parse = (denial: unknown) => rules.soundDenialSchema.safeParse(denial).success;
        expect(parse({ kind: "role", subject: "member" })).toBe(true);
        expect(parse({ kind: "role", subject: "org:sales-team" })).toBe(true);
        expect(parse({ kind: "role", subject: "owner" })).toBe(false);
        expect(parse({ kind: "role", subject: "org:" })).toBe(false);
        expect(parse({ kind: "role", subject: "org:Bad Slug" })).toBe(false);
        expect(parse({ kind: "user", subject: "not-a-uuid" })).toBe(false);
        expect(parse({ kind: "everyone", subject: ADA })).toBe(false);
    });
});

describe("whether a seat may use the soundboard", () => {
    it("is yes for a signed-in, unmuted seat in a conversation's call", () => {
        expect(rules.soundboardRefusal(facts())).toBeNull();
    });

    it("is yes in a direct message or a group, which have no space and no switch", () => {
        expect(rules.soundboardRefusal(facts({ space: null }))).toBeNull();
    });

    it.each([
        ["guest", { guest: true }],
        ["standalone", { standalone: true }],
        ["spaceOff", { space: { enabled: false, external: true } }],
        ["channelOff", { channelEnabled: false }],
        ["denied", { denied: true }],
        ["moderated", { serverMuted: true }],
        ["moderated", { serverDeafened: true }],
        ["deafened", { deafened: true }],
        ["muted", { muted: true }]
    ] as const)("is %s when it should be", (expected, overrides) => {
        expect(rules.soundboardRefusal(facts(overrides))).toBe(expected);
    });

    it("names the space being off before the person's own controls", () => {
        expect(
            rules.soundboardRefusal(
                facts({ space: { enabled: false, external: true }, denied: true, muted: true })
            )
        ).toBe("spaceOff");
        expect(rules.soundboardRefusal(facts({ denied: true, muted: true }))).toBe("denied");
    });
});

describe("whether one sound may be played here", () => {
    it("is always yes for a default", () => {
        const own = facts({ space: { enabled: true, external: false } });
        expect(rules.soundRefusal(own, { kind: "default" })).toBeNull();
    });

    it("lets anybody in the call play its own space's sounds, reaching the space or not", () => {
        expect(rules.soundRefusal(facts(), { kind: "space", here: true, reachable: false })).toBeNull();
    });

    it("is gone for a sound of a space the player does not reach", () => {
        expect(rules.soundRefusal(facts(), { kind: "space", here: false, reachable: false })).toBe(
            "gone"
        );
    });

    it("is refused from another space when this one keeps to its own", () => {
        const own = facts({ space: { enabled: true, external: false } });
        expect(rules.soundRefusal(own, { kind: "space", here: false, reachable: true })).toBe(
            "external"
        );
        expect(rules.soundRefusal(own, { kind: "space", here: true, reachable: true })).toBeNull();
    });

    it("lets a member bring their spaces' sounds into a direct message call", () => {
        expect(
            rules.soundRefusal(facts({ space: null }), { kind: "space", here: false, reachable: true })
        ).toBeNull();
    });
});

describe("a sound reference", () => {
    it("is a known default or a space sound's id, and nothing else", () => {
        expect(rules.parseSoundRef("default:applause")).toEqual({ kind: "default", id: "applause" });
        expect(rules.parseSoundRef(ADA.toUpperCase())).toEqual({ kind: "space", id: ADA });
        expect(rules.parseSoundRef("default:nope")).toBeNull();
        expect(rules.parseSoundRef("../etc/passwd")).toBeNull();
    });
});

describe("a sound's fields", () => {
    it("normalizes a name before checking its length", () => {
        expect(rules.soundNameSchema.parse("  big    drum ")).toBe("big drum");
        expect(rules.soundNameSchema.safeParse("  a  ").success).toBe(false);
        expect(rules.soundNameSchema.safeParse("x".repeat(33)).success).toBe(false);
    });

    it("takes one emoji or none", () => {
        expect(rules.soundEmojiSchema.safeParse("").success).toBe(true);
        expect(rules.soundEmojiSchema.safeParse("\u{1F44F}").success).toBe(true);
        expect(rules.soundEmojiSchema.safeParse("\u{1F1EA}\u{1F1F8}").success).toBe(true);
        expect(rules.soundEmojiSchema.safeParse("\u{1F44F}\u{1F44F}").success).toBe(false);
        expect(rules.soundEmojiSchema.safeParse("a").success).toBe(false);
    });

    it("keeps a volume between 0 and 1", () => {
        expect(rules.soundVolumeSchema.safeParse(0.5).success).toBe(true);
        expect(rules.soundVolumeSchema.safeParse(1.5).success).toBe(false);
        expect(rules.soundVolumeSchema.safeParse(-0.1).success).toBe(false);
    });
});

describe("what a listener hears", () => {
    const played = { volume: 0.5, userId: ADA };

    it("is the sound's volume times their own", () => {
        expect(rules.playbackVolume(played, { volume: 0.5, muted: new Set() })).toBe(0.25);
    });

    it("is nothing from somebody they muted", () => {
        expect(rules.playbackVolume(played, { volume: 1, muted: new Set([ADA]) })).toBe(0);
    });

    it("is nothing for a value that is not a number", () => {
        expect(
            rules.playbackVolume({ ...played, volume: Number.NaN }, { volume: 1, muted: new Set() })
        ).toBe(0);
    });
});

describe("a play on the wire", () => {
    const play = {
        kind: "sound",
        id: crypto.randomUUID(),
        from: crypto.randomUUID(),
        userId: ADA,
        sound: "default:horn",
        name: "",
        emoji: "\u{1F4EF}",
        volume: 1
    };

    it("is believed in its own shape", () => {
        expect(rules.soundPlayedSchema.safeParse(play).success).toBe(true);
    });

    it("is dropped when it points the clip anywhere but the sound route, or is too loud", () => {
        expect(
            rules.soundPlayedSchema.safeParse({ ...play, url: "https://example.com/x.wav" }).success
        ).toBe(false);
        expect(rules.soundPlayedSchema.safeParse({ ...play, volume: 4 }).success).toBe(false);
    });
});

/**
 * What a minor's account may use: the stage preset, a guardian's overrides,
 * and the floor no override reaches. Most cases are the ones that say no.
 */

import * as minors from "../../src/minors";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES, impliedBy, PERMISSIONS, type Permission } from "../../src/permissions";

const ceiling = (
    stage: minors.MinorStage,
    overrides: minors.MinorOverride[] = [],
    belowConsentAge = false
) => minors.minorCeiling({ stage, overrides, belowConsentAge });

describe("the floor", () => {
    it.each(minors.MINOR_STAGES)("holds at %s, whatever a guardian allows", (stage) => {
        const result = ceiling(
            stage,
            minors.MINOR_FLOOR.map((key) => ({ key, effect: "allow" as const }))
        );
        for (const key of minors.MINOR_FLOOR) expect(result.allowed.has(key)).toBe(false);
        expect(result.ignored.map((entry) => entry.reason)).toEqual(
            minors.MINOR_FLOOR.map(() => "floor")
        );
    });

    it("keeps administration and family.manage away from every minor", () => {
        for (const key of [
            "users.manage",
            "settings.manage",
            "system.manage",
            "family.manage"
        ] as const) {
            expect(minors.isFloorCapability(key)).toBe(true);
        }
    });

    it("is never a preset key", () => {
        for (const key of minors.MINOR_FLOOR) expect(key in minors.STAGE_PRESETS).toBe(false);
    });

    it("covers every key the presets do not", () => {
        for (const key of minors.MINOR_CAPABILITIES) {
            expect(minors.isFloorCapability(key) || key in minors.STAGE_PRESETS).toBe(true);
        }
    });
});

describe("stage presets", () => {
    it("give a baby nothing", () => {
        expect(ceiling("baby").allowed.size).toBe(0);
    });

    it("give a child everyday apps, chat with approved people, no vault or mail", () => {
        const result = ceiling("child");
        expect(result.allowed.has("drive.write")).toBe(true);
        expect(result.allowed.has("arcade.open")).toBe(true);
        expect(result.allowed.has("chat.use")).toBe(true);
        expect(result.contactsOnly.has("chat.use")).toBe(true);
        expect(result.contactsOnly.has("arcade.calls")).toBe(true);
        expect(result.allowed.has("chat.attach")).toBe(false);
        expect(result.allowed.has("vault.use")).toBe(false);
        expect(result.allowed.has("mail.use")).toBe(false);
        expect(result.allowed.has("shares.create")).toBe(false);
    });

    it("give a preteen the vault and game servers to read, groups with approved people", () => {
        const result = ceiling("preteen");
        expect(result.allowed.has("vault.use")).toBe(true);
        expect(result.allowed.has("games.read")).toBe(true);
        expect(result.allowed.has("games.console")).toBe(false);
        expect(result.contactsOnly.has("chat.groups")).toBe(true);
        expect(result.allowed.has("chat.spaces")).toBe(false);
        expect(result.allowed.has("mail.use")).toBe(false);
    });

    it("give a teen open chat and mail, no public links or Polar until a guardian says", () => {
        const result = ceiling("teen");
        expect(result.allowed.has("chat.use")).toBe(true);
        expect(result.contactsOnly.size).toBe(0);
        expect(result.allowed.has("mail.use")).toBe(true);
        expect(result.allowed.has("vpn.use")).toBe(true);
        expect(result.allowed.has("shares.create")).toBe(false);
        expect(result.allowed.has("app:polar")).toBe(false);
        expect(result.allowed.has("feature:polarMemories")).toBe(false);
    });

    it("give an older teen public links and Polar, still not deploys or meeting links", () => {
        const result = ceiling("olderTeen");
        expect(result.allowed.has("shares.create")).toBe(true);
        expect(result.allowed.has("feature:publicLinks")).toBe(true);
        expect(result.allowed.has("app:polar")).toBe(true);
        expect(result.allowed.has("feature:polarMemories")).toBe(true);
        expect(result.allowed.has("deploy.manage")).toBe(false);
        expect(result.allowed.has("chat.meetings")).toBe(false);
    });

    it("never widen from one stage to the next younger one", () => {
        for (let index = 1; index < minors.MINOR_STAGES.length; index++) {
            const younger = ceiling(minors.MINOR_STAGES[index - 1] as minors.MinorStage).allowed;
            const older = ceiling(minors.MINOR_STAGES[index] as minors.MinorStage).allowed;
            for (const key of younger) expect(older.has(key)).toBe(true);
        }
    });

    it("are coherent: nothing on by default needs something that is not", () => {
        for (const stage of minors.MINOR_STAGES) {
            const result = ceiling(stage);
            for (const key of result.allowed) {
                if (!(PERMISSIONS as readonly string[]).includes(key)) continue;
                for (const implied of impliedBy(key as Permission))
                    expect(result.allowed.has(implied)).toBe(true);
            }
        }
    });
});

describe("guardian overrides", () => {
    it("open a guardian-decided key", () => {
        expect(
            ceiling("teen", [{ key: "app:polar", effect: "allow" }]).allowed.has("app:polar")
        ).toBe(true);
    });

    it("close a key the stage gives", () => {
        expect(ceiling("teen", [{ key: "mail.use", effect: "deny" }]).allowed.has("mail.use")).toBe(
            false
        );
    });

    it("cannot open a key the stage does not offer yet", () => {
        const result = ceiling("child", [{ key: "vault.use", effect: "allow" }]);
        expect(result.allowed.has("vault.use")).toBe(false);
        expect(result.ignored).toEqual([
            { override: { key: "vault.use", effect: "allow" }, reason: "stageLocked" }
        ]);
    });

    it("keep a deny however the list is ordered", () => {
        const denyFirst = ceiling("teen", [
            { key: "mail.use", effect: "deny" },
            { key: "mail.use", effect: "allow" }
        ]);
        const denyLast = ceiling("teen", [
            { key: "mail.use", effect: "allow" },
            { key: "mail.use", effect: "deny" }
        ]);
        expect(denyFirst.allowed.has("mail.use")).toBe(false);
        expect(denyLast.allowed.has("mail.use")).toBe(false);
    });

    it("drop an allow whose implied permission is denied", () => {
        const result = ceiling("teen", [
            { key: "games.manage", effect: "allow" },
            { key: "games.moderate", effect: "allow" }
        ]);
        expect(result.allowed.has("games.manage")).toBe(false);
        expect(result.allowed.has("games.moderate")).toBe(true);
        expect(result.ignored).toEqual([
            { override: { key: "games.manage", effect: "allow" }, reason: "needs" }
        ]);
    });

    it("cascade when a denied read takes the writes with it", () => {
        const result = ceiling("teen", [{ key: "drive.read", effect: "deny" }]);
        expect(result.allowed.has("drive.write")).toBe(false);
        expect(result.allowed.has("drive.delete")).toBe(false);
    });

    it("keep the contact limit on an allowed contacts key", () => {
        const result = ceiling("child", [{ key: "chat.use", effect: "allow" }]);
        expect(result.contactsOnly.has("chat.use")).toBe(true);
    });
});

describe("the consent age", () => {
    it("makes profiling and third parties a guardian's to give below it", () => {
        const below = ceiling("olderTeen", [], true);
        expect(below.allowed.has("feature:polarMemories")).toBe(false);
        expect(below.allowed.has("feature:thirdParty")).toBe(false);
        expect(below.allowed.has("app:polar")).toBe(true);
        const allowed = ceiling(
            "olderTeen",
            [{ key: "feature:thirdParty", effect: "allow" }],
            true
        );
        expect(allowed.allowed.has("feature:thirdParty")).toBe(true);
    });

    it("is reached from the birth month", () => {
        const today = minors.parseCalendarDate("2026-11-07") as minors.CalendarDate;
        expect(minors.isPastConsentAge("2012-11", today)).toBe(true);
        expect(minors.isPastConsentAge("2012-12", today)).toBe(false);
        expect(minors.isPastConsentAge("2012-12", today, 13)).toBe(true);
    });
});

describe("what guardians see (D6)", () => {
    it("is everything up to preteen", () => {
        for (const stage of ["baby", "child", "preteen"] as const) {
            expect(Object.values(minors.guardianVisibility(stage, false)).every(Boolean)).toBe(
                true
            );
        }
    });

    it("drops usage and contacts from teen, or from the consent age", () => {
        for (const view of [
            minors.guardianVisibility("teen", false),
            minors.guardianVisibility("preteen", true)
        ]) {
            expect(view.appUsage).toBe(false);
            expect(view.contacts).toBe(false);
            expect(view.signIns).toBe(true);
            expect(view.requests).toBe(true);
            expect(view.restrictions).toBe(true);
        }
    });
});

describe("deny statements", () => {
    it("deny every permission the ceiling does not allow", () => {
        const denied = minors.deniedPermissions(ceiling("child"));
        expect(denied).toContain("vault.use");
        expect(denied).toContain("family.manage");
        expect(denied).not.toContain("drive.read");
        expect(
            denied.every((permission) => (PERMISSIONS as readonly string[]).includes(permission))
        ).toBe(true);
    });
});

describe("family.manage (D3)", () => {
    it("is a catalogued permission members hold by default", () => {
        expect(PERMISSIONS).toContain("family.manage");
        expect(DEFAULT_ROLES.member).toContain("family.manage");
        expect(DEFAULT_ROLES.viewer).not.toContain("family.manage");
        expect(DEFAULT_ROLES.guest).not.toContain("family.manage");
    });
});

import { namePlaces } from "../src/geo.js";
import { describe, expect, it } from "vitest";
import * as security from "../src/schemas/account-security.js";

describe("access rules", () => {
    it("accepts addresses and CIDR ranges, rejects anything else", () => {
        expect(security.ipRuleField.safeParse("203.0.113.7").success).toBe(true);
        expect(security.ipRuleField.safeParse("10.0.0.0/8").success).toBe(true);
        expect(security.ipRuleField.safeParse("fe80::/10").success).toBe(true);
        expect(security.ipRuleField.safeParse("example.com").success).toBe(false);
        expect(security.ipRuleField.safeParse("10.0.0.0/99").success).toBe(false);
    });

    it("deduplicates rules and normalizes country and continent codes", () => {
        const parsed = security.accessRulesSchema.parse({
            groupIds: [],
            allowedCidrs: ["10.0.0.0/8", "10.0.0.0/8"],
            allowedCountries: ["es", "ES", "pt"],
            allowedContinents: ["eu"]
        });
        expect(parsed.allowedCidrs).toEqual(["10.0.0.0/8"]);
        expect(parsed.allowedCountries).toEqual(["ES", "PT"]);
        expect(parsed.allowedContinents).toEqual(["EU"]);
    });

    it("rejects codes that are not real countries or continents", () => {
        expect(security.accessRulesSchema.safeParse({ allowedCountries: ["ZZ"] }).success).toBe(false);
        expect(security.accessRulesSchema.safeParse({ allowedContinents: ["XX"] }).success).toBe(false);
    });

    it("defaults every list so an empty object means no restriction", () => {
        const parsed = security.accessRulesSchema.parse({});
        expect(parsed).toEqual({
            groupIds: [],
            allowedCidrs: [],
            allowedCountries: [],
            allowedContinents: []
        });
    });

    it("requires a name on a group and drops the group list from its own rules", () => {
        expect(security.accessGroupSchema.safeParse({ name: "" }).success).toBe(false);
        const parsed = security.accessGroupSchema.parse({ name: "Home", allowedCidrs: ["10.0.0.0/8"] });
        expect(parsed).not.toHaveProperty("groupIds");
        expect(parsed.name).toBe("Home");
    });
});

describe("quick-unlock PIN", () => {
    it("takes 4 to 6 digits and nothing else", () => {
        for (const pin of ["1234", "123456"]) {
            expect(security.setPinSchema.safeParse({ pin, confirmPin: pin, password: "a-password" }).success).toBe(true);
        }
        for (const pin of ["123", "1234567", "12a4", ""]) {
            expect(security.setPinSchema.safeParse({ pin, confirmPin: pin, password: "a-password" }).success).toBe(false);
        }
    });

    it("rejects a confirmation that does not match", () => {
        const result = security.setPinSchema.safeParse({ pin: "1234", confirmPin: "4321", password: "a-password" });
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues[0]?.path).toEqual(["confirmPin"]);
    });
});

describe("session limits", () => {
    it("only accepts the offered durations", () => {
        expect(security.sessionLimitsSchema.safeParse({ idleLockMinutes: 15, sessionMaxMinutes: 1440 }).success).toBe(true);
        expect(security.sessionLimitsSchema.safeParse({ idleLockMinutes: 0, sessionMaxMinutes: 0 }).success).toBe(true);
        expect(security.sessionLimitsSchema.safeParse({ idleLockMinutes: 7, sessionMaxMinutes: 0 }).success).toBe(false);
    });
});

describe("recovery", () => {
    it("needs exactly three questions with usable answers", () => {
        const three = [
            { question: "Your first pet?", answer: "Rex" },
            { question: "City of birth?", answer: "Madrid" },
            { question: "First car?", answer: "Seat" }
        ];
        expect(security.securityQuestionsSchema.safeParse({ answers: three }).success).toBe(true);
        expect(security.securityQuestionsSchema.safeParse({ answers: three.slice(0, 2) }).success).toBe(false);
        expect(
            security.securityQuestionsSchema.safeParse({
                answers: [...three.slice(0, 2), { question: "First car?", answer: "a" }]
            }).success
        ).toBe(false);
    });

    it("requires one proof of identity: every answer, or a code", () => {
        const base = { newPassword: "a-long-enough-password" };
        expect(security.recoverPasswordSchema.safeParse(base).success).toBe(false);
        expect(security.recoverPasswordSchema.safeParse({ ...base, answers: ["a1", "b2"] }).success).toBe(false);
        expect(security.recoverPasswordSchema.safeParse({ ...base, answers: ["a1", "b2", "c3"] }).success).toBe(true);
        expect(security.recoverPasswordSchema.safeParse({ ...base, totpCode: "123456" }).success).toBe(true);
        expect(security.recoverPasswordSchema.safeParse({ ...base, totpCode: "12345" }).success).toBe(false);
    });

    it("holds the new password to the same minimum as a normal change", () => {
        expect(security.recoverPasswordSchema.safeParse({ newPassword: "short", totpCode: "123456" }).success).toBe(false);
    });
});

describe("api keys", () => {
    it("needs a name, at least one scope, and a known expiry", () => {
        const base = { name: "Backup script", scopes: ["drive.read"], expiresInDays: 90 };
        expect(security.createApiKeySchema.safeParse(base).success).toBe(true);
        expect(security.createApiKeySchema.safeParse({ ...base, scopes: [] }).success).toBe(false);
        expect(security.createApiKeySchema.safeParse({ ...base, name: "" }).success).toBe(false);
        expect(security.createApiKeySchema.safeParse({ ...base, expiresInDays: 45 }).success).toBe(false);
        expect(security.createApiKeySchema.safeParse({ ...base, scopes: ["drive.everything"] }).success).toBe(false);
    });

    it("carries the network rules a key may be limited to", () => {
        const parsed = security.createApiKeySchema.parse({
            name: "Backup script",
            scopes: ["drive.read", "drive.read"],
            expiresInDays: 0,
            allowedCidrs: ["10.0.0.0/8"]
        });
        expect(parsed.scopes).toEqual(["drive.read"]);
        expect(parsed.allowedCidrs).toEqual(["10.0.0.0/8"]);
    });

    it("writes out the scopes a picked one implies", () => {
        const parsed = security.createApiKeySchema.parse({
            name: "Backup script",
            scopes: ["deploy.manage", "drive.write"],
            expiresInDays: 90
        });
        // deploy.manage carries the game-server grants too: whoever may deploy
        // anything on this machine may already run a game server on it.
        expect(parsed.scopes).toEqual([
            "drive.read",
            "drive.write",
            "deploy.read",
            "deploy.manage",
            "games.read",
            "games.moderate",
            "games.manage"
        ]);
    });

    it("takes a hand-picked expiry date, but only one in the future and not absurdly far", () => {
        const base = { name: "Backup script", scopes: ["drive.read"], expiresInDays: 0 };
        const day = 24 * 60 * 60 * 1000;
        const at = (offset: number) => new Date(Date.now() + offset).toISOString();
        expect(security.createApiKeySchema.safeParse({ ...base, expiresAt: at(30 * day) }).success).toBe(true);
        expect(security.createApiKeySchema.safeParse({ ...base, expiresAt: at(-day) }).success).toBe(false);
        expect(security.createApiKeySchema.safeParse({ ...base, expiresAt: at(11 * 365 * day) }).success).toBe(false);
        expect(security.createApiKeySchema.safeParse({ ...base, expiresAt: "31/12/2026" }).success).toBe(false);
    });
});

describe("stored list columns", () => {
    it("round-trips a list through its stored string form", () => {
        expect(security.parseStringList(security.stringifyList(["a", "b", "a"]))).toEqual(["a", "b"]);
    });

    it("treats an absent or corrupted column as no entries", () => {
        expect(security.parseStringList(null)).toEqual([]);
        expect(security.parseStringList("")).toEqual([]);
        expect(security.parseStringList("not json")).toEqual([]);
        expect(security.parseStringList('{"not":"an array"}')).toEqual([]);
    });

    it("drops non-string entries rather than passing them on", () => {
        expect(security.parseStringList('["ok", 7, null]')).toEqual(["ok"]);
    });
});

describe("rule union", () => {
    const stored = (cidrs: string[], countries: string[] = [], continents: string[] = []) => ({
        allowedCidrs: security.stringifyList(cidrs),
        allowedCountries: security.stringifyList(countries),
        allowedContinents: security.stringifyList(continents)
    });

    it("merges every source and deduplicates across them", () => {
        const result = security.unionRules([
            stored(["10.0.0.0/8"], ["ES"]),
            stored(["10.0.0.0/8", "203.0.113.7"], ["PT"], ["EU"])
        ]);
        expect(result.allowedCidrs).toEqual(["10.0.0.0/8", "203.0.113.7"]);
        expect(result.allowedCountries).toEqual(["ES", "PT"]);
        expect(result.allowedContinents).toEqual(["EU"]);
    });

    it("only ever widens: adding a source cannot remove an existing rule", () => {
        const one = security.unionRules([stored(["10.0.0.0/8"])]);
        const two = security.unionRules([stored(["10.0.0.0/8"]), stored(["192.168.0.0/16"])]);
        expect(two.allowedCidrs).toEqual(expect.arrayContaining(one.allowedCidrs));
    });

    it("ignores absent sources, so an unconfigured target restricts nothing", () => {
        expect(security.unionRules([null, undefined])).toEqual({
            allowedCidrs: [],
            allowedCountries: [],
            allowedContinents: []
        });
        expect(security.unionRules([])).toEqual({ allowedCidrs: [], allowedCountries: [], allowedContinents: [] });
    });
});

describe("naming the places a rule admits", () => {
    it("names them, because a count is unreadable where there is no dialog to open", () => {
        expect(namePlaces(["ES", "PT"], ["EU"])).toEqual(["Europe", "Spain", "Portugal"]);
    });

    it("puts continents first: the broader rule is the one that explains the narrower", () => {
        expect(namePlaces(["ES"], ["EU"])[0]).toBe("Europe");
    });

    it("leaves an unrestricted rule set with nothing to say", () => {
        expect(namePlaces([], [])).toEqual([]);
    });

    it("falls back to the code rather than dropping a place it cannot name", () => {
        expect(namePlaces([], ["ZZ"])).toEqual(["ZZ"]);
    });
});

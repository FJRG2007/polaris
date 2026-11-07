/**
 * What the family actions accept. A birth month is checked against today, so
 * the cases are built from the current month rather than fixed dates.
 */

import { describe, expect, it } from "vitest";
import { calendarDateIn } from "../../src/minors";
import * as schemas from "../../src/schemas/minors";

const MINOR = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const GUARDIAN = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c";

/** `YYYY-MM`, `months` before the current month (negative: in the future). */
function monthsAgo(months: number): string {
    const today = calendarDateIn(new Date());
    const index = today.year * 12 + (today.month - 1) - months;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const child = {
    name: "  mia   lópez ",
    username: "Mia_2019",
    password: "lantern-river-42",
    birthMonth: monthsAgo(7 * 12)
};

describe("create a minor", () => {
    it("accepts a child with no email, normalized", () => {
        const parsed = schemas.createMinorSchema.parse({ ...child, email: "   " });
        expect(parsed.name).toBe("Mia López");
        expect(parsed.username).toBe("mia_2019");
        expect(parsed.email).toBeUndefined();
    });

    it("accepts an email when there is one", () => {
        expect(
            schemas.createMinorSchema.parse({ ...child, email: " Mia@Example.test " }).email
        ).toBe("mia@example.test");
    });

    it("refuses a birth month in the future, a malformed one, one over 120 years ago, or an adult's", () => {
        for (const birthMonth of [
            monthsAgo(-1),
            "2019-13",
            "2019-1",
            "",
            monthsAgo(121 * 12),
            monthsAgo(18 * 12)
        ]) {
            expect(schemas.createMinorSchema.safeParse({ ...child, birthMonth }).success).toBe(
                false
            );
        }
    });

    it("accepts the current month and the last month before majority", () => {
        for (const birthMonth of [monthsAgo(0), monthsAgo(18 * 12 - 1)]) {
            expect(schemas.createMinorSchema.safeParse({ ...child, birthMonth }).success).toBe(
                true
            );
        }
    });

    it("refuses an address that is not one", () => {
        expect(schemas.createMinorSchema.safeParse({ ...child, email: "mia@" }).success).toBe(
            false
        );
    });

    it("refuses a password built from the child's name", () => {
        const result = schemas.createMinorSchema.safeParse({
            ...child,
            password: "mia_2019mia_2019"
        });
        expect(result.success).toBe(false);
    });

    it("refuses a missing birth month (D4)", () => {
        const { birthMonth: _omitted, ...rest } = child;
        expect(schemas.createMinorSchema.safeParse(rest).success).toBe(false);
    });
});

describe("overrides", () => {
    it("accepts a list of allow and deny", () => {
        const parsed = schemas.setMinorOverridesSchema.parse({
            minorId: MINOR,
            overrides: [
                { key: "app:polar", effect: "allow" },
                { key: "mail.use", effect: "deny" }
            ]
        });
        expect(parsed.overrides).toHaveLength(2);
        expect(
            schemas.setMinorOverridesSchema.safeParse({ minorId: MINOR, overrides: [] }).success
        ).toBe(true);
    });

    it("refuses a floor key, an unknown key, a key listed twice, or another effect", () => {
        const refused = [
            [{ key: "users.manage", effect: "allow" }],
            [{ key: "family.manage", effect: "deny" }],
            [{ key: "feature:vpnTor", effect: "allow" }],
            [{ key: "drive.everything", effect: "allow" }],
            [
                { key: "mail.use", effect: "allow" },
                { key: "mail.use", effect: "deny" }
            ],
            [{ key: "mail.use", effect: "inherit" }]
        ];
        for (const overrides of refused) {
            expect(
                schemas.setMinorOverridesSchema.safeParse({ minorId: MINOR, overrides }).success
            ).toBe(false);
        }
    });

    it("refuses an id that is not one", () => {
        expect(
            schemas.setMinorOverridesSchema.safeParse({ minorId: "mia", overrides: [] }).success
        ).toBe(false);
    });
});

describe("delay a move", () => {
    it("accepts a real day and an optional reason, trimmed", () => {
        const parsed = schemas.delayStageSchema.parse({
            minorId: MINOR,
            until: "2028-02-29",
            reason: "  exams  "
        });
        expect(parsed.reason).toBe("exams");
    });

    it("refuses a day that does not exist or is not a day", () => {
        for (const until of ["2027-02-29", "2027-04-31", "2027-6-1", "tomorrow"]) {
            expect(schemas.delayStageSchema.safeParse({ minorId: MINOR, until }).success).toBe(
                false
            );
        }
    });

    it("refuses an overlong reason", () => {
        expect(
            schemas.delayStageSchema.safeParse({
                minorId: MINOR,
                until: "2028-01-01",
                reason: "x".repeat(281)
            }).success
        ).toBe(false);
    });
});

describe("assign a guardian", () => {
    it("defaults to a secondary guardian", () => {
        expect(
            schemas.assignGuardianSchema.parse({ minorId: MINOR, guardianId: GUARDIAN }).role
        ).toBe("secondary");
    });

    it("refuses somebody as their own guardian, or an unknown role", () => {
        expect(
            schemas.assignGuardianSchema.safeParse({ minorId: MINOR, guardianId: MINOR }).success
        ).toBe(false);
        expect(
            schemas.assignGuardianSchema.safeParse({
                minorId: MINOR,
                guardianId: GUARDIAN,
                role: "owner"
            }).success
        ).toBe(false);
    });
});

describe("set a stage", () => {
    it("accepts a stage and refuses adult or an unknown one", () => {
        expect(
            schemas.setMinorStageSchema.safeParse({ minorId: MINOR, stage: "teen" }).success
        ).toBe(true);
        expect(
            schemas.setMinorStageSchema.safeParse({ minorId: MINOR, stage: "adult" }).success
        ).toBe(false);
        expect(
            schemas.setMinorStageSchema.safeParse({ minorId: MINOR, stage: "toddler" }).success
        ).toBe(false);
    });
});

describe("digital consent age (D2)", () => {
    it("defaults to 14 and stays within 13 to 16", () => {
        expect(schemas.digitalConsentAgeField.parse(undefined)).toBe(14);
        expect(schemas.digitalConsentAgeField.parse(16)).toBe(16);
        for (const value of [12, 17, 14.5])
            expect(schemas.digitalConsentAgeField.safeParse(value).success).toBe(false);
    });
});

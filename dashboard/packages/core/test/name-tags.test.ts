import * as core from "../src/index.js";
import { describe, expect, it } from "vitest";

const member = core.nameTagDefinitionSchema({
    instanceName: "Polaris",
    staff: false,
    allowAvatar: true
});
const staff = core.nameTagDefinitionSchema({
    instanceName: "Polaris",
    staff: true,
    allowAvatar: false
});
const base = { enabled: true, emblem: "spark", color: "blue" };

describe("name tag schema", () => {
    it("trims and uppercases before checking", () => {
        expect(member.parse({ ...base, text: "  acme " }).text).toBe("ACME");
    });

    it("refuses empty, too long and non-alphanumeric text", () => {
        expect(member.safeParse({ ...base, text: "   " }).error?.issues[0]?.message).toBe(
            "required"
        );
        expect(member.safeParse({ ...base, text: "ACMEX" }).error?.issues[0]?.message).toBe(
            "tooLong"
        );
        expect(member.safeParse({ ...base, text: "A-B" }).error?.issues[0]?.message).toBe(
            "characters"
        );
    });

    it("keeps staff words and the instance name for administrators", () => {
        for (const text of ["mod", "ADMN", "staf", "pola", "POL"]) {
            expect(member.safeParse({ ...base, text }).error?.issues[0]?.message).toBe("reserved");
            expect(staff.safeParse({ ...base, text }).success).toBe(true);
        }
        expect(core.isReservedNameTag("ACME", "Polaris")).toBe(false);
    });

    it("refuses lookalikes of reserved words", () => {
        for (const text of ["M0D", "5TAF", "МОD", "АDМ", "P0L", "MÓD"])
            expect(member.safeParse({ ...base, text }).error?.issues[0]?.message).toBe("reserved");
        expect(core.isReservedNameTag("ÑU", "Polaris")).toBe(false);
    });

    it("lets a switched-off tag keep a reserved word", () => {
        expect(member.safeParse({ ...base, enabled: false, text: "MOD" }).success).toBe(true);
    });

    it("lets only organizations use their avatar, and only known colors", () => {
        expect(member.safeParse({ ...base, text: "ACME", emblem: "avatar" }).success).toBe(true);
        expect(staff.safeParse({ ...base, text: "ACME", emblem: "avatar" }).success).toBe(false);
        expect(member.safeParse({ ...base, text: "ACME", color: "#fff" }).success).toBe(false);
    });

    it("validates the choice as a tagged union", () => {
        expect(core.nameTagChoiceSchema.safeParse({ source: "org" }).success).toBe(false);
        expect(core.nameTagChoiceSchema.safeParse({ source: "none" }).success).toBe(true);
    });
});

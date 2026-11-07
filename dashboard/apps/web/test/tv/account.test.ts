import { describe, expect, it } from "vitest";
import { tvAccount, tvAccountSchema } from "@/lib/tv/account";

describe("the account a TV is told about", () => {
    it("greets by the first name the profile holds", () => {
        expect(tvAccount({ name: "Sample Person", firstName: "Sam", locale: "es-ES" })).toEqual({
            name: "Sample Person",
            firstName: "Sam",
            locale: "es-ES"
        });
    });

    it("falls back to the first word of the name", () => {
        expect(tvAccount({ name: "  Sample   Person ", firstName: "  " }).firstName).toBe("Sample");
    });

    it("sends no greeting name when there is none", () => {
        expect(tvAccount({ name: "", firstName: null }).firstName).toBeNull();
        expect(tvAccount({ name: null }).firstName).toBeNull();
    });

    it("strips control characters a TV could not show", () => {
        expect(tvAccount({ name: "Sample\nPerson" }).firstName).toBe("Sample");
        expect(tvAccount({ name: "x", firstName: "Sa\u0000m" }).firstName).toBe("Sa m");
    });

    it("caps the greeting name to one row", () => {
        expect(tvAccount({ name: "A".repeat(200) }).firstName).toHaveLength(40);
    });

    it("caps a name of astral characters without refusing it", () => {
        const first = tvAccount({ name: "\u{1F600}".repeat(60) }).firstName ?? "";
        expect(Array.from(first)).toHaveLength(40);
        expect(tvAccount({ name: "x", firstName: "\u{20000}".repeat(25) }).firstName).toBe("\u{20000}".repeat(25));
    });

    it("drops a locale Polaris does not have", () => {
        expect(tvAccount({ name: "Sample", locale: "xx-YY" }).locale).toBeNull();
        expect(tvAccount({ name: "Sample", locale: null }).locale).toBeNull();
    });

    it("leaves in the shape it declares", () => {
        const sent = tvAccount({ name: "Sample Person", firstName: "Sam", locale: "en-US" });
        expect(tvAccountSchema.safeParse(sent).success).toBe(true);
    });
});

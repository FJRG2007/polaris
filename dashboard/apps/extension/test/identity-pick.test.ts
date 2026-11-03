/**
 * Picking one identity's value for the box a menu is opened on: what the rows
 * lead with, what a pick replaces, and how a family name splits in two.
 */
import { describe, expect, it } from "vitest";
import * as identity from "../src/lib/identity";
import type { IdentityCard, IdentityValues } from "../src/lib/messages";

function values(over: Partial<IdentityValues> = {}): IdentityValues {
    return { ...identity.blankIdentity(), ...over };
}

function card(id: string, name: string, over: Partial<IdentityValues> = {}): IdentityCard {
    const open: identity.OpenIdentity = {
        id,
        name,
        organizationId: null,
        isDefault: false,
        values: values(over)
    };
    return identity.cardOf(open, new Map());
}

describe("splitting a family name into two surnames", () => {
    it("splits on the space", () => {
        expect(identity.splitSurnames("Romero González")).toEqual(["Romero", "González"]);
    });

    it("keeps particles with the word after them", () => {
        expect(identity.splitSurnames("de la Fuente García")).toEqual(["de la Fuente", "García"]);
        expect(identity.splitSurnames("García del Río")).toEqual(["García", "del Río"]);
        expect(identity.splitSurnames("San Martín López")).toEqual(["San Martín", "López"]);
    });

    it("gives a single surname to the first one whole", () => {
        expect(identity.splitSurnames("Smith")).toEqual(["Smith", ""]);
        expect(identity.splitSurnames("de la Fuente")).toEqual(["de la Fuente", ""]);
        expect(identity.splitSurnames("  ")).toEqual(["", ""]);
    });

    it("puts everything after the first surname into the second", () => {
        expect(identity.splitSurnames("Romero González López")).toEqual(["Romero", "González López"]);
    });
});

describe("what a pick types into each box", () => {
    const javier = values({
        firstName: "Javier",
        middleName: "Luis",
        lastName: "Romero González",
        email: "j@x.test",
        phone: "+34 600",
        username: "jrg"
    });

    it("splits the name for each part a form asks for", () => {
        expect(identity.slotValue(javier, "fullName", null)).toBe("Javier Luis Romero González");
        expect(identity.slotValue(javier, "givenName", null)).toBe("Javier");
        expect(identity.slotValue(javier, "middleName", null)).toBe("Luis");
        expect(identity.slotValue(javier, "familyName", null)).toBe("Romero González");
        expect(identity.slotValue(javier, "firstSurname", null)).toBe("Romero");
        expect(identity.slotValue(javier, "secondSurname", null)).toBe("González");
    });

    it("types into the username box what that box asks for", () => {
        expect(identity.slotValue(javier, "login", null)).toBe("j@x.test");
        expect(identity.slotValue(javier, "login", "phone")).toBe("+34 600");
        expect(identity.slotValue(javier, "login", "username")).toBe("jrg");
        expect(identity.slotValue(values({ username: "only" }), "login", "email")).toBe("only");
    });
});

describe("what a pick replaces even when filled", () => {
    it("replaces the whole address when opened on any part of it", () => {
        expect([...identity.replacedSlots("city")].sort()).toEqual(
            ["address1", "address2", "city", "country", "postalCode", "state"].sort()
        );
    });

    it("replaces the whole name when opened on any part of it", () => {
        expect(identity.replacedSlots("secondSurname").has("givenName")).toBe(true);
        expect(identity.replacedSlots("fullName").has("middleName")).toBe(true);
        expect(identity.replacedSlots("fullName").has("city")).toBe(false);
    });

    it("replaces a contact box alone", () => {
        for (const slot of ["email", "phone", "username", "company", "login"] as const) {
            expect([...identity.replacedSlots(slot)]).toEqual([slot]);
        }
        expect(identity.replacedSlots(null).size).toBe(0);
    });
});

describe("the preview a card carries", () => {
    it("holds the email, phone, street with city and whole name - nothing else", () => {
        const preview = identity.previewOf(
            values({
                firstName: "Ada",
                lastName: "King",
                email: " a@x.test ",
                phone: "123",
                address1: "Calle Mayor 1",
                address2: "2º B",
                city: "Madrid",
                postalCode: "28001"
            })
        );
        expect(preview).toEqual({
            email: "a@x.test",
            phone: "123",
            address: "Calle Mayor 1, Madrid",
            name: "Ada King"
        });
    });

    it("is on every card, the account's too", () => {
        expect(card("h", "Home", { email: "h@x.test" }).preview.email).toBe("h@x.test");
        expect(identity.accountCard(values({ email: "me@x.test" }), "Me").preview.email).toBe("me@x.test");
    });
});

describe("the value a menu leads with", () => {
    it("is the one the box asks for", () => {
        expect(identity.previewKey("email", null)).toBe("email");
        expect(identity.previewKey("login", null)).toBe("email");
        expect(identity.previewKey("login", "phone")).toBe("phone");
        expect(identity.previewKey("phone", null)).toBe("phone");
        expect(identity.previewKey("postalCode", null)).toBe("address");
        expect(identity.previewKey("givenName", null)).toBe("name");
        expect(identity.previewKey("company", null)).toBeNull();
        expect(identity.previewKey(null, null)).toBeNull();
    });
});

describe("the identity rows of a menu", () => {
    const home = card("home", "Home", { email: "me@x.test", address1: "Calle A 1", city: "Madrid" });
    const work = card("work", "Work", { email: "me@x.test", address1: "Av. B 2", city: "Bilbao" });
    const bare = card("bare", "Bare");

    it("leads each row with the identity's own value, and names the identity under it", () => {
        const rows = identity.identityRows([home, work], "address", "Default");
        expect(rows.map((row) => [row.label, row.detail])).toEqual([
            ["Calle A 1, Madrid", "Home"],
            ["Av. B 2, Bilbao", "Work"]
        ]);
    });

    it("draws identities with the same value as one row, the best ranked", () => {
        const rows = identity.identityRows([home, work], "email", "Default");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.card.id).toBe("home");
        const loud = card("loud", "Loud", { email: "ME@x.test " });
        expect(identity.identityRows([home, loud], "email", "Default")).toHaveLength(1);
    });

    it("falls back to the name and the usual detail for an identity with nothing for the box", () => {
        const rows = identity.identityRows([bare, home], "phone", "Default");
        expect(rows.map((row) => row.label)).toEqual(["Bare", "Home"]);
        expect(rows[1]?.detail).toBe("me@x.test");
    });

    it("says which is the default and which vault holds it", () => {
        const main = { ...home, isDefault: true };
        const org = { ...work, vault: "Acme" };
        const rows = identity.identityRows([main, org], "address", "Default");
        expect(rows.map((row) => row.detail)).toEqual(["Home - Default", "Work - Acme"]);
    });
});

/**
 * The registry of ways in, which is what a form and a request both read.
 *
 * The screen decides whether the button is available from these functions, and
 * the action decides whether anything is stored from the same ones. That is the
 * whole reason they are pure and here: two answers to "is this filled in" is one
 * of them being wrong, and the one that is wrong is always the server's.
 */

import { describe, expect, it } from "vitest";
import * as registry from "@polaris-app/places/src/lib/device-connections";

const NUKI_WEB = "nuki-web";

describe("the ways in", () => {
    it("has a driver's worth of detail for every one it offers", () => {
        // A method listed with no fields is a screen asking for nothing and then
        // failing; one with no summary is a choice made blind.
        for (const connection of registry.DEVICE_CONNECTIONS) {
            expect(connection.fields.length).toBeGreaterThan(0);
            expect(connection.summary.length).toBeGreaterThan(0);
            expect(connection.kinds.length).toBeGreaterThan(0);
        }
    });

    it("gives every connection an id of its own", () => {
        const ids = registry.DEVICE_CONNECTIONS.map((connection) => connection.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("finds a make by what its owner would call the thing they bought", () => {
        expect(registry.searchConnections("smart lock").map((entry) => entry.id)).toContain(
            NUKI_WEB
        );
    });

    it("counts the ways in per make, so a screen can say there was a choice", () => {
        const nuki = registry.deviceBrands().find((entry) => entry.brand === "Nuki");
        expect(nuki?.count).toBe(registry.connectionsOfBrand("Nuki").length);
    });
});

describe("what a connection was given", () => {
    const connection = registry.deviceConnection(NUKI_WEB);

    it("is not complete while a required field is empty", () => {
        expect(connection).not.toBeNull();
        expect(registry.fieldsComplete(connection!, {})).toBe(false);
    });

    it("says nothing about an empty field", () => {
        // An emptied box is unfinished, not invalid. "That does not look like a
        // token" over a field nobody has typed in is telling somebody off for not
        // having got there yet.
        const field = connection!.fields[0]!;
        expect(registry.fieldIssue(field, "")).toBeNull();
        expect(registry.fieldIssue(field, "   ")).toBeNull();
    });

    it("complains about something typed that cannot be right", () => {
        const field = connection!.fields[0]!;
        expect(registry.fieldIssue(field, "abc")).not.toBeNull();
    });

    it("accepts what it asked for", () => {
        const fields = { token: "0123456789012345678901234567890123456789" };
        expect(registry.fieldsComplete(connection!, fields)).toBe(true);
    });

    it("keeps only the fields the connection declared", () => {
        // What arrives is somebody else's object. Anything not on the list is
        // dropped here rather than encrypted and kept for the life of the row.
        const clean = registry.normalizeFields(connection!, {
            token: "  0123456789012345678901234567890123456789  ",
            smuggled: "keep me",
            nested: { no: true }
        });
        expect(clean).toEqual({ token: "0123456789012345678901234567890123456789" });
    });

    it("never offers to show a credential back", () => {
        expect(registry.shownFields(connection!).map((field) => field.key)).not.toContain("token");
    });
});

describe("a connection made by pairing", () => {
    const paired = registry.DEVICE_CONNECTIONS.filter((connection) => connection.pairing);

    it("exists, so the checks below read something", () => {
        expect(paired.map((connection) => connection.id)).toContain("tuya-app");
    });

    it("says what to show while it waits, in both languages", async () => {
        const { placesCatalogs } = await import("@polaris-app/places/messages");
        for (const locale of ["en-US", "es-ES"] as const) {
            const t = placesCatalogs.translator(locale, "places");
            for (const connection of paired) {
                expect(
                    registry.connectionWords(t, connection).pairingPrompt,
                    `${locale} ${connection.id}`
                ).toBeTruthy();
            }
        }
    });

    it("waits long enough to be scanned, and asks often enough to feel instant", () => {
        for (const connection of paired) {
            expect(connection.pairing!.pollMs).toBeGreaterThanOrEqual(1_000);
            expect(connection.pairing!.lifetimeMs).toBeGreaterThan(connection.pairing!.pollMs * 10);
        }
    });

    it("asks for an emailed code where the maker sends one", () => {
        const philips = registry.deviceConnection("philips-cloud");
        expect(philips?.pairing?.kind).toBe("code");
        const email = philips!.fields[0]!;
        expect(registry.fieldIssue(email, "owner@")).not.toBeNull();
        expect(registry.fieldIssue(email, "owner@example.com")).toBeNull();
        expect(registry.fieldIssue(email, "")).toBeNull();
        expect(registry.fieldsComplete(philips!, { email: "owner@example" })).toBe(false);
        expect(registry.fieldsComplete(philips!, { email: " owner@example.com " })).toBe(true);
    });

    it("keeps the typed Tuya project as a second way in", () => {
        expect(registry.connectionsOfBrand("Tuya").map((connection) => connection.id)).toEqual([
            "tuya-app",
            "tuya-cloud"
        ]);
    });
});

describe("the recommended way in", () => {
    it("is marked on exactly one connection of every brand", () => {
        for (const { brand } of registry.deviceBrands()) {
            const marked = registry
                .connectionsOfBrand(brand)
                .filter((connection) => connection.recommended);
            expect(marked, brand).toHaveLength(1);
        }
    });

    it("is listed first, so the order still reads best first", () => {
        for (const { brand } of registry.deviceBrands()) {
            expect(registry.connectionsOfBrand(brand)[0]?.recommended, brand).toBe(true);
        }
    });

    it("is the app sign-in for Tuya and the web account for Nuki", () => {
        expect(registry.recommendedConnection("Tuya")?.id).toBe("tuya-app");
        expect(registry.recommendedConnection("Nuki")?.id).toBe("nuki-web");
    });

    it("stays local for Philips, with the unofficial account second", () => {
        expect(registry.connectionsOfBrand("Philips").map((connection) => connection.id)).toEqual([
            "philips-coap",
            "philips-cloud"
        ]);
        expect(registry.recommendedConnection("Philips")?.id).toBe("philips-coap");
    });

    it("is nothing for a brand that does not exist", () => {
        expect(registry.recommendedConnection("Nobody")).toBeNull();
    });
});

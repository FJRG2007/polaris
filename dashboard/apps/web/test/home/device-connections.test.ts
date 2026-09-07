/**
 * The registry of ways in, which is what a form and a request both read.
 *
 * The screen decides whether the button is available from these functions, and
 * the action decides whether anything is stored from the same ones. That is the
 * whole reason they are pure and here: two answers to "is this filled in" is one
 * of them being wrong, and the one that is wrong is always the server's.
 */

import { describe, expect, it } from "vitest";
import * as registry from "@/lib/home/device-connections";

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
        expect(registry.searchConnections("smart lock").map((entry) => entry.id)).toContain(NUKI_WEB);
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

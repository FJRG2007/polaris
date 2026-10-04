/**
 * The registry of ways in, which is what a form and a request both read.
 *
 * The screen decides whether the button is available from these functions, and
 * the action decides whether anything is stored from the same ones. That is the
 * whole reason they are pure and here: two answers to "is this filled in" is one
 * of them being wrong, and the one that is wrong is always the server's.
 */

import { describe, expect, it } from "vitest";
import { placesCatalogs } from "@polaris-app/places/messages";
import * as registry from "@polaris-app/places/src/lib/device-connections";

const NUKI_WEB = "nuki-web";

describe("the ways in", () => {
    it("has a driver's worth of detail for every one it offers", () => {
        // A method listed with no fields is a screen asking for nothing and then
        // failing; one with no summary is a choice made blind.
        for (const connection of registry.DEVICE_CONNECTIONS) {
            expect(connection.summary.length).toBeGreaterThan(0);
            expect(connection.kinds.length).toBeGreaterThan(0);
            // One listed only to say why it cannot be used asks for nothing,
            // and says why instead.
            if (connection.unavailable) {
                expect(connection.fields, connection.id).toEqual([]);
                expect(connection.unavailable.length).toBeGreaterThan(0);
                continue;
            }
            expect(connection.fields.length).toBeGreaterThan(0);
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
        const email = philips!.fields.find((field) => field.key === "email")!;
        expect(registry.fieldIssue(email, "owner@")).not.toBeNull();
        expect(registry.fieldIssue(email, "owner@example.com")).toBeNull();
        expect(registry.fieldIssue(email, "")).toBeNull();
        expect(registry.fieldsComplete(philips!, { country: "ES", email: "owner@example" })).toBe(
            false
        );
        expect(
            registry.fieldsComplete(philips!, { country: "ES", email: " owner@example.com " })
        ).toBe(true);
        // A comma or space left over from a paste is another address to Philips.
        for (const slip of [
            "owner@example.com,",
            "owner@example.com;",
            "owner @example.com",
            "owner@example..com"
        ]) {
            expect(registry.fieldIssue(email, slip)).not.toBeNull();
            expect(registry.fieldsComplete(philips!, { country: "ES", email: slip })).toBe(false);
        }
        expect(registry.normalizeFields(philips!, { email: " Owner@Example.COM " }).email).toBe(
            "owner@example.com"
        );
        expect(registry.normalizeField(email, " Owner@Example.COM ")).toBe("owner@example.com");
    });

    it("asks a Philips account's country first, from the countries Philips serves", () => {
        const philips = registry.deviceConnection("philips-cloud")!;
        const country = philips.fields[0]!;
        expect(country.key).toBe("country");
        expect(country.countries).toBe(true);
        expect(country.secret).toBeUndefined();
        expect(registry.fieldIssue(country, "ES")).toBeNull();
        expect(registry.fieldIssue(country, "JP")).toBe("Pick one of the listed options");
        // No country, no code: the region decides where the devices are read.
        expect(registry.fieldsComplete(philips, { email: "owner@example.com" })).toBe(false);
        // Shown on a reconnect, like any address: it is not a secret.
        expect(registry.shownFields(philips).map((field) => field.key)).toContain("country");
        const es = placesCatalogs.translator("es-ES", "places");
        const words = registry.fieldWords(es, philips, country);
        expect(words.label).toBe("País o región");
        expect(words.choices?.find((choice) => choice.value === "ES")?.label).toBe("España");
        expect(words.choices?.map((choice) => choice.label)).toEqual(
            [...(words.choices ?? [])]
                .map((choice) => choice.label)
                .sort((a, b) => a.localeCompare(b, "es-ES"))
        );
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
            "philips-cloud",
            "hue-bridge",
            "philips-dynalite",
            "hue-ble",
            "philips-tv"
        ]);
        expect(registry.recommendedConnection("Philips")?.id).toBe("philips-coap");
    });

    it("is nothing for a brand that does not exist", () => {
        expect(registry.recommendedConnection("Nobody")).toBeNull();
    });
});

describe("Philips' ways in", () => {
    it("are one make, Hue included, each drawn with its own mark", () => {
        const brands = registry.deviceBrands().map((entry) => entry.brand);
        expect(brands).toContain("Philips");
        expect(brands).not.toContain("Philips Hue");
        const marks = Object.fromEntries(
            registry.connectionsOfBrand("Philips").map((way) => [way.id, way.logo])
        );
        expect(marks).toMatchObject({
            "philips-coap": "philips",
            "hue-bridge": "philipshue",
            "hue-ble": "philipshue",
            "philips-dynalite": "philips",
            "philips-tv": "philips"
        });
        expect(registry.searchConnections("hue").map((way) => way.id)).toEqual(
            expect.arrayContaining(["hue-bridge", "hue-ble"])
        );
    });

    it("never count one that cannot be used as filled in", () => {
        for (const id of ["hue-ble", "philips-tv"]) {
            const way = registry.deviceConnection(id)!;
            expect(way.unavailable, id).toMatch(/^Not available: /);
            expect(registry.fieldsComplete(way, {})).toBe(false);
        }
    });

    it("say why in the reader's language", () => {
        const es = placesCatalogs.translator("es-ES", "places");
        const tv = registry.connectionWords(es, registry.deviceConnection("philips-tv")!);
        expect(tv.unavailable).toMatch(/^No disponible: /);
        const hue = registry.connectionWords(es, registry.deviceConnection("hue-bridge")!);
        expect(hue.unavailable).toBeUndefined();
    });
});

describe("what a Philips sign-in says it looked at", () => {
    const philips = registry.deviceConnection("philips-cloud")!;

    const SEEN = [
        { where: "Air+", region: "eu-west-1", count: 0, models: [] },
        { where: "HomeID app", count: null, models: [], failure: "HTTP 500" },
        { where: "HomeID app sign-in", count: 1, models: ["AC1715/11"] },
        {
            where: "HomeID account",
            region: "eu-west-1",
            count: null,
            models: [],
            failure: "HTTP 401/403"
        },
        { where: "Local network", count: 0, models: [] },
        { where: "Philips Air", count: null, models: [], failure: "network" }
    ];

    it("names each place and its answer in the reader's language", () => {
        const said = (locale: "en-US" | "es-ES") => {
            const t = placesCatalogs.translator(locale, "places");
            return SEEN.map((lookup) => {
                const words = registry.lookupWords(t, philips, lookup);
                return [words.place, words.result];
            });
        };
        expect(said("en-US")).toEqual([
            ["Air+ app's device list (Europe)", "No devices"],
            ["HomeID appliances", "Philips' server failed (HTTP 500)"],
            ["HomeID appliances, signed in the way the HomeID app does", "1 device (AC1715/11)"],
            ["Account check (Europe)", "Refused the sign-in"],
            ["This network", "No Philips purifier answered"],
            ["Philips cloud for fans and heaters", "No answer"]
        ]);
        expect(said("es-ES")).toEqual([
            ["Lista de aparatos de la app Air+ (Europa)", "Ningún aparato"],
            ["Aparatos de HomeID", "Falló el servidor de Philips (HTTP 500)"],
            ["Aparatos de HomeID, accediendo como lo hace la app HomeID", "1 aparato (AC1715/11)"],
            ["Comprobación de la cuenta (Europa)", "Rechazó el acceso"],
            ["Esta red", "Ningún purificador respondió"],
            ["Nube de Philips para ventiladores y calefactores", "No respondió"]
        ]);
    });

    it("shows a place or a failure it has no words for as the server named it", () => {
        const t = placesCatalogs.translator("en-US", "places");
        expect(
            registry.lookupWords(t, philips, {
                where: "Somewhere new",
                count: null,
                models: [],
                failure: "teapot"
            })
        ).toEqual({ place: "Somewhere new", result: "teapot", failed: true });
        expect(
            registry.lookupWords(t, philips, {
                where: "HomeID",
                region: "eu-west-1",
                count: null,
                models: [],
                failure: "HTTP 404"
            })
        ).toEqual({
            place: "HomeID app's device list (Europe)",
            result: "Failed (HTTP 404)",
            failed: true
        });
    });
});

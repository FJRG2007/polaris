/**
 * Every sentence Places refuses with, in the reader's language.
 *
 * The services under `lib` throw in English - a `HomeError`, a driver's or an
 * integration's own error - and the actions and the screens that show a stored
 * one hand it through `placesRefusalText`. A sentence that function does not
 * know passes through untouched, which is right for a camera's own words and
 * wrong for one Places wrote. This reads every literal sentence those classes are
 * built with and holds each one to coming out in Spanish.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { placesCatalogs } from "@polaris-app/places/messages";
import { placesRefusalText } from "@polaris-app/places/src/lib/refusal-text";
import { outageHeadline, outageLength } from "@polaris-app/places/src/lib/reachability";

const LIB = fileURLToPath(new URL("../../../places/src/lib/", import.meta.url));

/** `new HomeError("A sentence")` and its siblings, the sentence possibly on the
 *  next line. */
const BUILT = /new (?:HomeError|DriverError|NukiError|TuyaError|BrokerError)\(\s*"([^"\\]+)"/g;

async function files(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await files(path)));
        else if (entry.name.endsWith(".ts")) found.push(path);
    }
    return found;
}

async function sentences(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const path of await files(LIB)) {
        const source = await readFile(path, "utf8");
        for (const match of source.matchAll(BUILT)) found.set(match[1]!, path.slice(LIB.length));
    }
    return found;
}

describe("a refusal from Places", () => {
    const es = placesCatalogs.translator("es-ES", "places");
    const en = placesCatalogs.translator("en-US", "places");

    it("finds the sentences it is checking", async () => {
        // A pattern that stopped matching would pass everything below.
        expect((await sentences()).size).toBeGreaterThan(50);
    });

    it("has a Spanish sentence for every one Places writes", async () => {
        const untranslated = [...(await sentences())]
            .filter(([sentence]) => placesRefusalText(es, sentence) === sentence)
            .map(([sentence, file]) => `${file}: ${sentence}`);
        expect(untranslated).toEqual([]);
    });

    it("reads the same in English as it was thrown", async () => {
        for (const [sentence, file] of await sentences()) {
            expect(placesRefusalText(en, sentence), file).toBe(sentence);
        }
    });

    it("fills in what a shaped one carries", () => {
        expect(placesRefusalText(es, "Front door has to be connected again")).toBe(
            "Hay que volver a conectar Front door"
        );
        expect(placesRefusalText(es, "A lock cannot be told to turn on")).toContain(
            "una cerradura"
        );
    });

    it("keeps what a Philips sign-in saw, in Spanish around it", () => {
        expect(
            placesRefusalText(
                es,
                "Polaris found no device on this Philips account. What it saw: Air+: 0; HomeID: HTTP 403; HomeID app: 1 (AC0651/10); Philips Air: 0. Check that the device is in a Philips app under this same email."
            )
        ).toBe(
            "Polaris no ha encontrado ningún dispositivo en esta cuenta Philips. Lo que vio: Air+: 0; HomeID: HTTP 403; HomeID app: 1 (AC0651/10); Philips Air: 0. Comprueba que está en una app de Philips con este mismo email."
        );
    });

    it("keeps what Philips said when it refused, in Spanish around it", () => {
        expect(
            placesRefusalText(
                es,
                "Philips did not accept the code. Check it, or ask for a new one. Philips said: Invalid code (403042)."
            )
        ).toBe(
            "Philips no ha aceptado el código. Compruébalo o pide otro. Philips dijo: Invalid code (403042)."
        );
        expect(
            placesRefusalText(
                es,
                "Philips did not send a code to that address. Check it is the one you sign in to the Air+ app with. Philips said: Invalid parameter value (400006)."
            )
        ).toBe(
            "Philips no ha enviado un código a esa dirección. Comprueba que es la que usas en la app Air+. Philips dijo: Invalid parameter value (400006)."
        );
    });

    it("passes a camera's own words through", () => {
        const said = "401 Unauthorized: bad digest";
        expect(placesRefusalText(es, said)).toBe(said);
    });
});

describe("an outage, stored in English and read in Spanish", () => {
    const es = placesCatalogs.translator("es-ES", "places");

    it("says the same thing either way it is reached", () => {
        for (const [down, total, place] of [
            [4, 4, "Home"],
            [1, 4, "Home"],
            [2, 5, ""],
            [1, 1, "Home"]
        ] as const) {
            const stored = outageHeadline("Front door", place, down, total);
            expect(placesRefusalText(es, stored)).toBe(
                outageHeadline("Front door", place, down, total, es)
            );
        }
    });

    it("agrees a length with its number", () => {
        const since = new Date("2026-01-01T10:00:00Z");
        expect(outageLength(since, new Date("2026-01-01T10:01:00Z"), es)).toBe("1 minuto");
        expect(outageLength(since, new Date("2026-01-01T13:00:00Z"), es)).toBe("3 horas");
    });
});

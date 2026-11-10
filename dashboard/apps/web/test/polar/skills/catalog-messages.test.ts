/**
 * The marketplace screens build message keys from catalog ids, so every id
 * must have its words in every locale - a missing one would show the raw key.
 */

import { describe, expect, it } from "vitest";
import en from "../../../messages/en-US/polar.json";
import es from "../../../messages/es-ES/polar.json";
import { SKILL_CATALOG } from "@/lib/polar/skills/catalog";
import { CONNECTOR_CATALOG } from "@/lib/polar/connectors/catalog";

describe("catalog messages", () => {
    for (const [locale, messages] of [
        ["en-US", en],
        ["es-ES", es]
    ] as const) {
        it(`has every catalog entry's words in ${locale}`, () => {
            const settings = messages.settings as unknown as {
                connectorCatalog: { entries: Record<string, string>; fields: Record<string, string> };
                skills: { catalog: Record<string, { title: string; description: string }> };
            };
            for (const entry of CONNECTOR_CATALOG) {
                expect(settings.connectorCatalog.entries[entry.id]).toBeTruthy();
                if (entry.available) {
                    for (const header of entry.headers ?? []) {
                        expect(settings.connectorCatalog.fields[header.label]).toBeTruthy();
                        if (header.pattern) {
                            expect(
                                settings.connectorCatalog.fields[`${header.label}Invalid`]
                            ).toBeTruthy();
                        }
                    }
                }
            }
            for (const skill of SKILL_CATALOG) {
                expect(settings.skills.catalog[skill.id]?.title).toBeTruthy();
                expect(settings.skills.catalog[skill.id]?.description).toBeTruthy();
            }
        });
    }
});

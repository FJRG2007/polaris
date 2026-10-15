import type { ZodTypeAny } from "zod";
import { describe, expect, it } from "vitest";
import { operationId } from "@/lib/api-docs/openapi";
import { translatorFor } from "@/lib/i18n/translate";
import { DOCUMENTED_ROUTES } from "@/lib/api-docs/routes";
import { toJsonSchema } from "@/lib/api-docs/json-schema";
import { referenceCopy } from "@/lib/api-docs/reference-copy";

/** Every parameter of a route with the English its schema describes it in. */
function describedParameters(route: (typeof DOCUMENTED_ROUTES)[number]): [string, string][] {
    const schemas = {
        ...(route.params ?? {}),
        ...((route.query?.shape ?? {}) as Record<string, ZodTypeAny>)
    };
    return [
        ...Object.entries(schemas).flatMap(([name, schema]): [string, string][] => {
            const description = toJsonSchema(schema).description;
            return typeof description === "string" ? [[name, description]] : [];
        }),
        ...Object.entries(route.binaryBody?.headers ?? {})
    ];
}

describe("API reference copy", () => {
    it("says in en-US exactly what the OpenAPI document says", () => {
        const t = translatorFor("en-US", "account");
        for (const route of DOCUMENTED_ROUTES) {
            const copy = referenceCopy(t, route, operationId(route));
            expect(copy.tag).toBe(route.tag);
            expect(copy.summary).toBe(route.summary);
            expect(copy.description).toBe(route.description ?? null);
            for (const [status, response] of Object.entries(route.responses)) {
                expect(copy.response(status, response.description)).toBe(response.description);
            }
            for (const [name, english] of describedParameters(route))
                expect(copy.parameter(name, english)).toBe(english);
        }
    });

    it("has every word of the screen in every locale, never the English fallback", () => {
        for (const locale of ["en-US", "es-ES"] as const) {
            const t = translatorFor(locale, "account");
            for (const route of DOCUMENTED_ROUTES) {
                const op = `apiKeys.reference.ops.${operationId(route)}`;
                expect(t.has(`apiKeys.reference.tags.${route.tag}`), `${locale} ${route.tag}`).toBe(
                    true
                );
                expect(t.has(`${op}.summary`), `${locale} ${op}`).toBe(true);
                if (route.description)
                    expect(t.has(`${op}.description`), `${locale} ${op}`).toBe(true);
                for (const status of Object.keys(route.responses)) {
                    const held =
                        t.has(`${op}.responses.${status}`) ||
                        t.has(`apiKeys.reference.statuses.${status}`);
                    expect(held, `${locale} ${op} ${status}`).toBe(true);
                }
                for (const [name] of describedParameters(route)) {
                    const held =
                        t.has(`${op}.params.${name}`) || t.has(`apiKeys.reference.params.${name}`);
                    expect(held, `${locale} ${op} ${name}`).toBe(true);
                }
            }
        }
    });
});

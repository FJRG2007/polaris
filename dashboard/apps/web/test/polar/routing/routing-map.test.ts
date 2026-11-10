/**
 * The coding-tools table: each row names the model a call lands on the way
 * `routeFor` routes it - a tier's own pick, else the default model, else
 * Automatic - and the effort once Inherit is resolved.
 */

import { describe, expect, it } from "vitest";
import { effectiveEffort, toolMappings } from "@/lib/polar/routing-map";
import { POLAR_ROUTING_DEFAULTS, type PolarRouting } from "@/lib/polar/routing";

const SONNET = { provider: "anthropic", model: "claude-s", reasoning: "high" as const, keyId: null };
const BASE = { provider: "openai", model: "gpt-x", reasoning: "inherit" as const, keyId: null };

const routing = (patch: Partial<PolarRouting>): PolarRouting => ({ ...POLAR_ROUTING_DEFAULTS, ...patch });

describe("toolMappings", () => {
    it("lists the default first, then fable, opus, sonnet and haiku", () => {
        expect(toolMappings(routing({})).map((row) => row.asked)).toEqual([
            "default",
            "fable",
            "opus",
            "sonnet",
            "haiku"
        ]);
    });

    it("says every row is Automatic when nothing is set", () => {
        for (const row of toolMappings(routing({}))) {
            expect(row.target).toBeNull();
            expect(row.via).toBe("automatic");
            expect(row.effort).toBe(POLAR_ROUTING_DEFAULTS.defaultReasoning);
        }
    });

    it("sends a tier with no pick of its own to the default model", () => {
        const rows = toolMappings(
            routing({
                defaultModel: BASE,
                defaultReasoning: "medium",
                tiers: { ...POLAR_ROUTING_DEFAULTS.tiers, sonnet: SONNET }
            })
        );
        const by = Object.fromEntries(rows.map((row) => [row.asked, row]));
        expect(by.default).toMatchObject({ target: BASE, via: "own", effort: "medium" });
        expect(by.sonnet).toMatchObject({ own: SONNET, target: SONNET, via: "own", effort: "high" });
        expect(by.opus).toMatchObject({ own: null, target: BASE, via: "default", effort: "medium" });
    });
});

describe("effectiveEffort", () => {
    it("resolves Inherit and a missing target to the default effort", () => {
        expect(effectiveEffort("inherit", { defaultReasoning: "low" })).toBe("low");
        expect(effectiveEffort(undefined, { defaultReasoning: "client" })).toBe("client");
        expect(effectiveEffort("max", { defaultReasoning: "low" })).toBe("max");
    });
});

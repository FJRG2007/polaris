/**
 * The routing editor's shape: a row per fallback with its effort and key, a
 * stored key that is gone said as "(unavailable)", the add row while there is
 * room and the full message once there is not, and everything as text when
 * the routing is only being shown; and the pure step that adds or changes one
 * fallback.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FALLBACKS_MOST, POLAR_ROUTING_DEFAULTS, type PolarRouting } from "@/lib/polar/routing";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => {
        const t = (key: string, values?: Record<string, unknown>) =>
            values ? `${key}${JSON.stringify(values)}` : key;
        return Object.assign(t, { rich: t });
    }
}));
vi.mock("@/components/polar/elements/model-selector", () => ({
    ModelSelector: () => <span data-picker="" />
}));

const { RoutingEditor, keyOptions, withFallback } = await import("@/components/polar/routing-editor");

const OWN = "0190a3c2-7a3e-7000-8000-000000000001";
const GONE = "0190a3c2-7a3e-7000-8000-000000000009";
const KEYS = [
    { id: OWN, provider: "anthropic", name: "Mine", source: "own" as const },
    { id: "0190a3c2-7a3e-7000-8000-000000000002", provider: "anthropic", name: "Team", source: "instance" as const }
];
const PROVIDERS = [
    {
        provider: "anthropic",
        name: "Anthropic",
        payers: [],
        models: [{ provider: "anthropic", model: "claude-a", name: "Claude A", reasoning: true }]
    }
];

const routing = (fallbacks: PolarRouting["fallbacks"]): PolarRouting => ({
    ...POLAR_ROUTING_DEFAULTS,
    fallbacks
});

describe("RoutingEditor", () => {
    it("lists each fallback by name with its place, and offers the add row", () => {
        const html = renderToStaticMarkup(
            <RoutingEditor
                value={routing([{ provider: "anthropic", model: "claude-a", reasoning: "high", keyId: OWN }])}
                onChange={() => undefined}
                providers={PROVIDERS}
                keys={KEYS}
            />
        );
        expect(html).toContain("Claude A");
        expect(html).toContain("routing.fallbacks.add");
        expect(html).toContain("routing.tools.askOther");
        expect(html).not.toContain("routing.fallbacks.full");
    });

    it("says a model that is no longer offered is unavailable", () => {
        const html = renderToStaticMarkup(
            <RoutingEditor
                value={routing([{ provider: "anthropic", model: "gone", reasoning: "inherit", keyId: null }])}
                providers={PROVIDERS}
                keys={KEYS}
            />
        );
        expect(html).toContain("routing.notOffered");
        expect(html).toContain("anthropic/gone");
    });

    it("shows the full message instead of the add row at the most", () => {
        const fallbacks = Array.from({ length: FALLBACKS_MOST }, (_, index) => ({
            provider: "anthropic",
            model: `m-${index}`,
            reasoning: "inherit" as const,
            keyId: null
        }));
        const html = renderToStaticMarkup(
            <RoutingEditor value={routing(fallbacks)} onChange={() => undefined} providers={PROVIDERS} keys={KEYS} />
        );
        expect(html).toContain("routing.fallbacks.full");
        expect(html).not.toContain("routing.fallbacks.add");
    });

    it("draws read-only routing as text with no add row", () => {
        const html = renderToStaticMarkup(
            <RoutingEditor
                value={routing([{ provider: "anthropic", model: "claude-a", reasoning: "low", keyId: OWN }])}
                providers={PROVIDERS}
                keys={KEYS}
            />
        );
        expect(html).toContain("routing.effort.low");
        expect(html).toContain("Mine");
        expect(html).not.toContain("routing.fallbacks.add");
        expect(html).not.toContain("data-picker");
    });
});

describe("keyOptions", () => {
    const t = ((key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${String(values.name)}` : key) as never;

    it("offers any key first, then the provider's keys, the deployment's marked", () => {
        expect(keyOptions(t, KEYS, "anthropic").map((option) => option.label)).toEqual([
            "routing.keys.any",
            "Mine",
            "routing.keys.deployment:Team"
        ]);
        expect(keyOptions(t, KEYS, "openai")).toHaveLength(1);
    });

    it("keeps a stored key that is gone as unavailable", () => {
        const options = keyOptions(t, KEYS, "anthropic", GONE);
        expect(options.at(-1)).toEqual({ value: GONE, label: "routing.keys.unavailable" });
    });
});

describe("withFallback", () => {
    const a = { provider: "anthropic", model: "claude-a", reasoning: "inherit" as const, keyId: null };
    const b = { provider: "anthropic", model: "claude-b", reasoning: "high" as const, keyId: OWN };

    it("adds a new one at the end", () => {
        expect(withFallback([a], b, null)).toEqual({ ok: true, fallbacks: [a, b] });
    });

    it("refuses a model and key already listed, but not the row being changed", () => {
        expect(withFallback([a, b], { ...b, reasoning: "low" }, null)).toEqual({
            ok: false,
            refusal: "duplicate"
        });
        expect(withFallback([a, b], { ...b, reasoning: "low" }, 1)).toEqual({
            ok: true,
            fallbacks: [a, { ...b, reasoning: "low" }]
        });
        expect(withFallback([a, b], { ...b }, 0)).toEqual({ ok: false, refusal: "duplicate" });
    });

    it("lets the same model in again on another key", () => {
        const result = withFallback([b], { ...b, keyId: null }, null);
        expect(result.ok).toBe(true);
    });

    it("refuses one past the most, and still allows a change when full", () => {
        const full = Array.from({ length: FALLBACKS_MOST }, (_, index) => ({ ...a, model: `m-${index}` }));
        expect(withFallback(full, b, null)).toEqual({ ok: false, refusal: "tooMany" });
        expect(withFallback(full, b, 0).ok).toBe(true);
    });
});

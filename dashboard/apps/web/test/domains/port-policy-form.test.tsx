/**
 * The control that decides how the router is asked to open game ports.
 *
 * Its job is to be honest about the trade: one range that never has to be
 * revisited, or a rule per server. What it must not do is accept a range the
 * write would then refuse, because the field is where an operator finds out -
 * the alternative is a save that fails with the router already half configured.
 *
 * Rendered to static markup: these are assertions about what the form offers and
 * what it refuses, and none of them need a browser.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_PORT_BLOCKS, parseBlockInput } from "../../src/lib/apps/port-block";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("../../src/app/(app)/admin/domains/actions", () => ({
    savePortPolicyAction: async () => ({ policy: "range" as const, blocks: DEFAULT_PORT_BLOCKS })
}));

const { PortPolicyForm } = await import("../../src/app/(app)/admin/domains/port-policy-form");

describe("the port policy form", () => {
    it("shows the blocks as they are typed, not as JSON", () => {
        const markup = renderToStaticMarkup(<PortPolicyForm policy="range" blocks={DEFAULT_PORT_BLOCKS} />);

        expect(markup).toContain("25565-25664");
        expect(markup).toContain("19132-19231");
    });

    it("opens on the policy in force rather than on a default", () => {
        const markup = renderToStaticMarkup(<PortPolicyForm policy="per-port" blocks={DEFAULT_PORT_BLOCKS} />);

        expect(markup).toContain("another rule in the router");
    });

    it("leaves Save disabled until something differs from what was loaded", () => {
        const markup = renderToStaticMarkup(<PortPolicyForm policy="range" blocks={DEFAULT_PORT_BLOCKS} />);

        expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    });
});

describe("what the field will accept", () => {
    // The form validates with this and the action saves with it, so a range that
    // passes here cannot be rejected on the way to the database.
    it("takes a range written the way it is displayed", () => {
        expect(parseBlockInput("25565-25664")).toEqual({ start: 25565, end: 25664 });
        expect(parseBlockInput(" 30000 - 30099 ")).toEqual({ start: 30000, end: 30099 });
    });

    it("refuses one that would swallow the ports the websites answer on", () => {
        expect(parseBlockInput("80-500")).toBeNull();
        expect(parseBlockInput("400-500")).toBeNull();
    });

    it("refuses the privileged ports, a backwards range, and anything that is not one", () => {
        expect(parseBlockInput("22-1023")).toBeNull();
        expect(parseBlockInput("25664-25565")).toBeNull();
        expect(parseBlockInput("25565")).toBeNull();
        expect(parseBlockInput("25565-")).toBeNull();
        expect(parseBlockInput("70000-70100")).toBeNull();
    });
});

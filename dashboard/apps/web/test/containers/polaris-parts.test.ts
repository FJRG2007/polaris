/**
 * Telling Polaris apart from what Polaris runs.
 *
 * The trap this exists for: everything Polaris deploys is deployed with compose
 * too, under a project named `polaris-<hash>`. Anything that matched on that
 * prefix - or on container names, which begin with `polaris-` for the stack and
 * change on every self-update - would quietly add a Minecraft world's memory to
 * the control plane's own figure, and the figure would still look plausible.
 */

import { describe, expect, it } from "vitest";
import { describePart, isPolarisPart } from "@/lib/polaris-parts";

function container(name: string, project: string | null, service: string | null = null) {
    return { name, composeProject: project, composeService: service };
}

describe("what counts as Polaris", () => {
    it("takes the stack itself", () => {
        expect(isPolarisPart(container("polaris-web-181", "polaris", "web"))).toBe(true);
        expect(isPolarisPart(container("polaris-postgres-1", "polaris", "postgres"))).toBe(true);
    });

    it("takes the tunnels the control plane opens for its own address", () => {
        expect(isPolarisPart(container("ptunnel", "polaris-ptunnel", "ptunnel"))).toBe(true);
        expect(isPolarisPart(container("polaris-tunnel", "polaris-tunnel", "polaris-tunnel"))).toBe(true);
    });

    it("refuses a deployed app, whose project only looks like the stack's", () => {
        expect(isPolarisPart(container("marketplace-bed-wars-36e7", "polaris-36e74d11"))).toBe(false);
        expect(isPolarisPart(container("qtunnel-e6babdc4", "polaris-qtunnel-e6babdc4"))).toBe(false);
    });

    it("refuses a container nobody started with compose, whatever it is called", () => {
        expect(isPolarisPart(container("polaris-something", null))).toBe(false);
    });
});

describe("what a part is called", () => {
    it("names the parts of the stack", () => {
        expect(describePart(container("polaris-web-181", "polaris", "web")).label).toBe("Dashboard");
        expect(describePart(container("polaris-edge-guard-1", "polaris", "edge-guard")).label).toBe("Edge guard");
    });

    it("still gives a row to a part it has not been told about", () => {
        const grown = describePart(container("polaris-newthing-1", "polaris", "newthing"));
        expect(grown.label).toBe("newthing");
        expect(grown.summary).toBe("");
    });

    it("falls back to the container name when compose named no service", () => {
        expect(describePart(container("polaris-tunnel", "polaris-tunnel", null)).label).toBe("polaris-tunnel");
    });
});

/**
 * The "Install updates" control. The quiet hour is the default and names its
 * hour; a host that cannot install on its own shows "Only tell me" and says why,
 * rather than offering a schedule that would fail every night.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import type { AutoUpdatePolicy } from "@polaris/core";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/(app)/admin/updates/actions", () => ({
    securityUpdatePolicyAction: async () => ({
        policy: { critical: "immediate", high: "immediate", medium: "quiet", low: "quiet", riskAccepted: null },
        quietHour: 2
    }),
    saveSecurityUpdateAction: async () => ({}),
    updateChangelogAction: async () => null,
    ownVulnerabilitiesAction: async () => null,
    checkUpdatesAction: async () => ({}),
    saveAutoUpdateAction: async () => ({}),
    saveUpdateSourceAction: async () => ({}),
    triggerHostUpdateAction: async () => ({ status: "started" }),
    updateReportAction: async () => ({ url: "" })
}));

const { UpdatesView } = await import("@/app/(app)/admin/updates/updates-view");

function card(policy: AutoUpdatePolicy, canInstall: boolean, locale: "en-US" | "es-ES" = "en-US") {
    return renderToStaticMarkup(
        withMessages(
            <UpdatesView
                initialPolicy={policy}
                initialSource="image"
                quietHour={2}
                canInstall={canInstall}
                deployment={{ branch: "main", autoUpdate: canInstall }}
            />,
            locale
        )
    );
}

describe("the install schedule", () => {
    it("shows the quiet hour with its time, where this host can install", () => {
        const markup = card({ mode: "quiet", at: "05:00" }, true);
        expect(markup).toContain("At the quietest hour (02:00)");
        expect(markup).toContain("Installs at 02:00, when Polaris is least used.");
    });

    it("reads as only telling, with the reason, where it cannot", () => {
        const markup = card({ mode: "quiet", at: "05:00" }, false);
        expect(markup).toContain("Only tell me");
        expect(markup).not.toContain("At the quietest hour (02:00)");
        expect(markup).toContain("This host cannot install updates on its own, so Polaris only tells you.");
    });

    it("says the same in Spanish", () => {
        expect(card({ mode: "quiet", at: "05:00" }, true, "es-ES")).toContain("En la hora más tranquila (02:00)");
        expect(card({ mode: "quiet", at: "05:00" }, false, "es-ES")).toContain("Solo avisarme");
    });
});

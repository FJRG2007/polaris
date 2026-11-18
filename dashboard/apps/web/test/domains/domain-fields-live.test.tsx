// @vitest-environment jsdom

/**
 * The Domains page says a typed domain is wrong while it is being typed, and the
 * Save waits for a right one - rather than storing `////` as the sharing domain.
 */

import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const saved = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("../../src/app/(app)/admin/domains/actions", () => ({
    saveDomainsAction: async (input: unknown) => {
        saved.calls.push(input);
        return { config: { appDomain: "", sharingDomain: "", duckdnsSubdomain: "" } };
    }
}));
vi.mock("../../src/app/(app)/admin/domains/setup-actions", () => ({}));
vi.mock("../../src/app/(app)/admin/domains/tailscale-actions", () => ({}));
vi.mock("../../src/app/(app)/admin/integrations/actions", () => ({}));
vi.mock("../../src/app/(app)/account/domains/dns-actions", () => ({}));
vi.mock("../../src/app/(app)/apps/deploy/restore-actions", () => ({
    listHistoryAction: async () => ({ points: [] }),
    restoreHistoryAction: async () => ({})
}));

const { AppDomains, DuckDns } = await import("../../src/app/(app)/admin/domains/domains-view");

const config = {
    appDomain: "polaris.example.com",
    sharingDomain: "",
    duckdnsSubdomain: "",
    hasDuckdnsToken: false,
    extraDomains: []
} as unknown as Parameters<typeof AppDomains>[0]["config"];

afterEach(() => {
    cleanup();
    saved.calls = [];
});

// The label wraps the hint under the field too, so it is matched by how it starts.
const field = (label: string) =>
    screen.getByLabelText(new RegExp(`^${label}`), { selector: "input" }) as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

describe("Polaris's own addresses", () => {
    it("says a sharing domain of //// is not an address, and will not save it", () => {
        render(
            withMessages(
                <AppDomains
                    config={config}
                    suggestions={{ app: null, sharing: null } as never}
                    effectiveAppUrl="https://polaris.example.com"
                    onSaved={() => undefined}
                />
            )
        );
        fireEvent.change(field("Sharing domain"), { target: { value: "////" } });

        expect(field("Sharing domain").getAttribute("aria-invalid")).toBe("true");
        expect(screen.getByText("Use an address like polaris.example.com, with no path.")).toBeTruthy();
        expect(save().disabled).toBe(true);

        fireEvent.change(field("Sharing domain"), { target: { value: "share.example.com" } });
        expect(field("Sharing domain").getAttribute("aria-invalid")).toBe("false");
        expect(screen.queryByText("Use an address like polaris.example.com, with no path.")).toBeNull();
        expect(save().disabled).toBe(false);
    });

    it("does not count a stored value read back the same way as an edit", () => {
        render(
            withMessages(
                <AppDomains
                    config={{ ...config, appDomain: "https://polaris.example.com/" }}
                    suggestions={{ app: null, sharing: null } as never}
                    effectiveAppUrl="https://polaris.example.com"
                    onSaved={() => undefined}
                />
            )
        );
        expect(save().disabled).toBe(true);
    });
});

describe("the DuckDNS card", () => {
    it("refuses a name that is not one label, as it is typed", () => {
        render(withMessages(<DuckDns config={config} onConfig={() => undefined} />));
        fireEvent.change(field("Subdomain"), { target: { value: "my.polaris" } });

        expect(field("Subdomain").getAttribute("aria-invalid")).toBe("true");
        expect(save().disabled).toBe(true);
    });
});

/**
 * How the address list offers a removal.
 *
 * Pressing the X on an address is one press away from a name Polaris stops
 * answering on - possibly the one the page is being read over - so the question
 * belongs in a dialog that has to be answered, not in a line of text under the
 * row that a reader can miss and a stray click can confirm. What is pinned here
 * is the closed state: the control exists on the addresses that can be removed,
 * carries the wording for what removal means for that kind, and nothing offers a
 * confirmation inline. The open dialog is Radix's portal, which renders nothing
 * server-side, so this suite cannot reach it.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CheckedAddress } from "@/lib/address-health";

vi.mock("@/components/display-format", () => ({
    useDisplayFormat: () => ({ dateTime: (value: Date) => value.toISOString() })
}));
vi.mock("@/app/(app)/admin/domains/actions", () => ({
    removeAddressAction: async () => ({ addresses: [] })
}));

const { AddressList } = await import("@/components/address-list");

function address(overrides: Partial<CheckedAddress> = {}): CheckedAddress {
    return {
        kind: "domain",
        host: "polaris.example.com",
        url: "https://polaris.example.com",
        health: { state: "up", checkedAt: null, detail: null },
        ...overrides
    };
}

function tunnel(): CheckedAddress {
    return address({ kind: "tunnel", host: "quick.trycloudflare.com", url: "https://quick.trycloudflare.com" });
}

function render(addresses: CheckedAddress[]): string {
    return renderToStaticMarkup(<AddressList addresses={addresses} onChanged={() => {}} />);
}

describe("the deployment's address list", () => {
    it("offers to close a tunnel", () => {
        const markup = render([tunnel()]);
        expect(markup).toContain('title="Close the tunnel"');
        expect(markup).toContain('aria-label="Stop using quick.trycloudflare.com"');
    });

    it("offers to stop using a configured domain", () => {
        const markup = render([address()]);
        expect(markup).toContain('title="Stop using this domain"');
    });

    it("asks in a dialog rather than under the row", () => {
        const markup = render([address(), tunnel()]);
        expect(markup).not.toContain("Confirm");
        expect(markup).not.toContain("Cancel");
        expect(markup).not.toContain("Stop answering on");
    });

    it("leaves the addresses it cannot remove without the control", () => {
        const markup = render([
            address({ kind: "app", host: "polaris.local", url: "http://polaris.local" }),
            address({ kind: "local", host: "192.168.1.20", url: "http://192.168.1.20" })
        ]);
        expect(markup).not.toContain("aria-label=\"Stop using");
    });
});

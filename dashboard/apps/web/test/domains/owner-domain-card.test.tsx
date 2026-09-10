/**
 * What a domain of one's own shows about its certificate and its records.
 *
 * Rendered to static markup - the first frame, before any effect runs - which is
 * the state a reader lands on: a verified domain says what its wildcard
 * certificate covers and until when, a domain with its own DNS token offers its
 * records, and one still waiting on DNS shows the records to publish.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OwnerDomainView } from "@/lib/owner-domains";

vi.mock("../../src/app/(app)/account/domains/actions", () => ({}));
vi.mock("../../src/app/(app)/account/domains/dns-actions", () => ({}));

const { OwnerDomainsView } = await import("@/components/owner-domains-view");

function domain(overrides: Partial<OwnerDomainView>): OwnerDomainView {
    return {
        id: "0192a0b1-0000-7000-8000-000000000001",
        domain: "example.test",
        txtName: "_polaris.example.test",
        txtValue: "polaris-verify=0123",
        wildcard: "*.example.test",
        verified: true,
        wildcardOk: true,
        checkedAt: "2026-09-10T10:00:00.000Z",
        detail: "",
        createdAt: "2026-09-01T10:00:00.000Z",
        hasDnsToken: false,
        certificate: null,
        ...overrides
    };
}

function render(domains: OwnerDomainView[]): string {
    return renderToStaticMarkup(
        <OwnerDomainsView
            owner={{ kind: "user" }}
            domains={domains}
            canAdd={false}
            blockedReason=""
            publicIp="203.0.113.10"
            instanceDomains={[]}
        />
    );
}

describe("a domain of one's own", () => {
    it("says what its wildcard certificate covers once it is issued", () => {
        const markup = render([
            domain({
                certificate: {
                    status: "issued",
                    expiresAt: "2026-12-01T00:00:00.000Z",
                    nextAttemptAt: null,
                    detail: null
                }
            })
        ]);
        expect(markup).toContain("Wildcard certificate");
        expect(markup).toContain("Issued");
        expect(markup).toContain("Covers *.example.test and example.test until");
        // No token of its own: the field to give it one, and no record editor.
        expect(markup).toContain("Cloudflare API token");
        expect(markup).not.toContain("DNS records");
    });

    it("says why an order failed and when it is tried again", () => {
        const markup = render([
            domain({
                certificate: {
                    status: "failed",
                    expiresAt: null,
                    nextAttemptAt: "2026-09-10T11:00:00.000Z",
                    detail: "example.test is not on a domain in this Cloudflare account."
                }
            })
        ]);
        expect(markup).toContain("Not issued");
        expect(markup).toContain("is not on a domain in this Cloudflare account.");
        expect(markup).toContain("Next try");
        expect(markup).toContain("Try now");
    });

    it("offers its records when it carries a token of its own", () => {
        const markup = render([domain({ hasDnsToken: true })]);
        expect(markup).toContain("DNS records");
        expect(markup).toContain("Remove token");
    });

    it("shows the records to publish while it waits on DNS, and no certificate yet", () => {
        const markup = render([domain({ verified: false, wildcardOk: false })]);
        expect(markup).toContain("Waiting on DNS");
        expect(markup).toContain("_polaris.example.test");
        expect(markup).not.toContain("Wildcard certificate");
    });
});

/**
 * A zone's records as the table draws them, and the order and filters behind it.
 *
 * Rendered to static markup - the frame before any effect runs - because what is
 * asserted is what the table shows: Cloudflare's columns, a long value cut short
 * but kept whole where it can be recovered, rows pulsing rather than blank while
 * the first read is on its way, and a row whose write has not come back yet.
 */

import { describe, expect, it } from "vitest";
import * as view from "@/lib/dns/records-view";
import { renderToStaticMarkup } from "react-dom/server";
import type { DnsRecordView } from "@/lib/dns/zone-records";
import { emptyDraft, recordFields } from "@/lib/dns/record-schema";
import { DnsRecordsTable } from "@/components/dns/dns-records-table";

function record(overrides: Partial<DnsRecordView> & Pick<DnsRecordView, "id" | "type" | "relative">): DnsRecordView {
    const name = overrides.relative === "@" ? "example.test" : `${overrides.relative}.example.test`;
    return {
        name,
        content: "203.0.113.10",
        ttl: 1,
        proxied: false,
        proxiable: false,
        priority: null,
        draft: emptyDraft("A"),
        ...overrides
    };
}

const LONG_DKIM = `v=DKIM1; k=rsa; p=${"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA".repeat(6)}`;

const records: DnsRecordView[] = [
    record({ id: "t", type: "TXT", relative: "mail._domainkey", content: LONG_DKIM }),
    record({ id: "a2", type: "A", relative: "www", proxied: true, proxiable: true }),
    record({ id: "m", type: "MX", relative: "@", content: "mx.example.test", priority: 10 }),
    record({ id: "a1", type: "A", relative: "api", ttl: 300, proxiable: true }),
    record({ id: "x", type: "HTTPS", relative: "@", content: '1 . alpn="h2"', draft: null })
];

function render(rows: readonly DnsRecordView[] | null, pending: string[] = []): string {
    return renderToStaticMarkup(
        <DnsRecordsTable
            records={rows}
            pending={new Set(pending)}
            checking={null}
            empty="No records yet."
            onCheck={() => undefined}
            onEdit={() => undefined}
            onDelete={() => undefined}
        />
    );
}

describe("the order and the filters", () => {
    it("lists by type, then by name", () => {
        expect(view.listedRecords(records, view.NO_RECORD_FILTERS).map((entry) => entry.id)).toEqual(["a1", "a2", "x", "m", "t"]);
    });

    it("narrows by type and by a search over the name and the content", () => {
        expect(view.listedRecords(records, { type: "A", search: "" }).map((entry) => entry.id)).toEqual(["a1", "a2"]);
        expect(view.listedRecords(records, { type: view.ALL_TYPES, search: "DOMAINKEY" }).map((entry) => entry.id)).toEqual(["t"]);
        expect(view.listedRecords(records, { type: view.ALL_TYPES, search: "mx.example" }).map((entry) => entry.id)).toEqual(["m"]);
        expect(view.listedRecords(records, { type: "TXT", search: "www" })).toEqual([]);
    });

    it("offers only the types the zone holds", () => {
        expect(view.recordTypesIn(records)).toEqual(["A", "HTTPS", "MX", "TXT"]);
    });

    it("builds the row a write shows before Cloudflare answers", () => {
        const draft = { ...emptyDraft("MX"), name: "@", content: "MX2.Example.Test.", priority: "20" };
        const checked = recordFields(draft, "example.test");
        if (!checked.ok) throw new Error("the draft should be valid");
        expect(view.pendingView("pending-1", checked.record, draft, "example.test")).toMatchObject({
            id: "pending-1",
            type: "MX",
            name: "example.test",
            relative: "@",
            content: "mx2.example.test",
            priority: 20,
            proxiable: false
        });
    });
});

describe("the records table", () => {
    it("has Cloudflare's columns", () => {
        const markup = render(records);
        for (const column of ["Type", "Name", "Content", "Proxy status", "TTL", "Actions"]) {
            expect(markup).toContain(column);
        }
    });

    it("cuts a long value short and keeps it whole in its title and its copy button", () => {
        const markup = render(records);
        expect(markup).toContain(`title="${LONG_DKIM}"`);
        expect(markup).toContain(`aria-label="Copy content ${LONG_DKIM}"`);
        expect(markup).toContain('title="mail._domainkey.example.test"');
        expect(markup).toContain('aria-label="Copy name mail._domainkey.example.test"');
    });

    it("says the proxy status and the TTL in words", () => {
        const markup = render(records);
        expect(markup).toContain("Proxied");
        expect(markup).toContain("DNS only");
        expect(markup).toContain("5 min");
        expect(markup).toContain("Auto");
    });

    it("labels every action with the record it acts on", () => {
        const markup = render(records);
        expect(markup).toContain('aria-label="Delete the A record www"');
        expect(markup).toContain('aria-label="Edit the MX record @"');
        expect(markup).toContain('aria-label="Check where the TXT record mail._domainkey has reached"');
        // A type the editor does not write can be deleted, not edited.
        expect(markup).toContain('aria-label="Delete the HTTPS record @"');
        expect(markup).not.toContain('aria-label="Edit the HTTPS record @"');
    });

    it("pulses its rows, not its header, while the first read is on its way", () => {
        const markup = render(null);
        expect(markup).toContain("Proxy status");
        expect(markup).toContain("animate-pulse");
        expect(markup).toContain('aria-busy="true"');
        expect(markup).not.toContain("No records yet.");
    });

    it("says so when there is nothing to list", () => {
        expect(render([])).toContain("No records yet.");
    });

    it("dims a row whose write has not come back, and holds its actions", () => {
        const markup = render([records[1]!], ["a2"]);
        expect(markup).toContain("opacity-60");
        expect(markup).not.toContain('aria-label="Edit the A record www"');
        expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Delete the A record www"/);
    });
});

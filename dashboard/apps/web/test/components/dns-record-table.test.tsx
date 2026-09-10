/**
 * Records somebody has to create at their registrar, as a table. A record is
 * typed into a registrar's form one field at a time, so the name and the value
 * each have their own copy button - and a value not known yet is said in words
 * and offers nothing to copy.
 */

import { DnsRecordTable } from "@polaris/ui";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

describe("DnsRecordTable", () => {
    it("shows the type, and a copy button for the name and for the value", () => {
        const html = renderToStaticMarkup(
            <DnsRecordTable
                records={[
                    {
                        type: "TXT",
                        name: "_polaris.example.test",
                        value: "polaris-verify=abc",
                        note: "Proves the domain is yours."
                    }
                ]}
            />
        );
        for (const column of ["Type", "Name", "Content"]) expect(html).toContain(column);
        expect(html).toContain(">TXT<");
        expect(html).toContain('aria-label="Copy name _polaris.example.test"');
        expect(html).toContain('aria-label="Copy value polaris-verify=abc"');
        expect(html).toContain("Proves the domain is yours.");
    });

    it("offers no copy for a value that is not known yet", () => {
        const html = renderToStaticMarkup(
            <DnsRecordTable
                records={[
                    {
                        type: "A",
                        name: "*.apps.example.test",
                        value: null,
                        valueFallback: "your public IP"
                    }
                ]}
            />
        );
        expect(html).toContain("your public IP");
        expect(html).not.toContain("Copy value");
        expect(html).toContain("Copy name *.apps.example.test");
    });

    it("says whether each record is in place, with a status column only when one has a status", () => {
        const html = renderToStaticMarkup(
            <DnsRecordTable
                records={[
                    { type: "A", name: "a.example.test", value: "203.0.113.7", status: "done" },
                    { type: "A", name: "b.example.test", value: "203.0.113.7", status: "conflict" }
                ]}
            />
        );
        expect(html).toContain("Status");
        expect(html).toContain("In place");
        expect(html).toContain("Points elsewhere");
        expect(
            renderToStaticMarkup(
                <DnsRecordTable records={[{ type: "A", name: "a", value: "203.0.113.7" }]} />
            )
        ).not.toContain("Status");
    });

    it("shows a value whole rather than cut short, since it is copied into another form", () => {
        const value = `v=DKIM1; p=${"A".repeat(300)}`;
        const html = renderToStaticMarkup(
            <DnsRecordTable records={[{ type: "TXT", name: "mail._domainkey", value }]} />
        );
        expect(html).toContain(`>${value}<`);
        expect(html).not.toContain("truncate");
    });
});

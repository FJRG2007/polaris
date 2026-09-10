/**
 * A DNS record is typed into a registrar's form one field at a time, so each
 * value has its own copy button - and a value not known yet is said in words
 * and offers nothing to copy.
 */

import { DnsRecordCard } from "@polaris/ui";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

describe("DnsRecordCard", () => {
    it("shows the type, and a copy button for the name and for the value", () => {
        const html = renderToStaticMarkup(
            <DnsRecordCard
                type="TXT"
                name="_polaris.example.test"
                value="polaris-verify=abc"
                note="Proves the domain is yours."
            />
        );
        expect(html).toContain(">TXT<");
        expect(html).toContain('aria-label="Copy name _polaris.example.test"');
        expect(html).toContain('aria-label="Copy value polaris-verify=abc"');
        expect(html).toContain("Proves the domain is yours.");
    });

    it("offers no copy for a value that is not known yet", () => {
        const html = renderToStaticMarkup(
            <DnsRecordCard
                type="A"
                name="*.apps.example.test"
                value={null}
                valueFallback="your public IP"
            />
        );
        expect(html).toContain("your public IP");
        expect(html).not.toContain("Copy value");
        expect(html).toContain("Copy name *.apps.example.test");
    });

    it("says whether the record is in place", () => {
        expect(
            renderToStaticMarkup(
                <DnsRecordCard type="A" name="a" value="203.0.113.7" status="done" />
            )
        ).toContain("In place");
        expect(
            renderToStaticMarkup(
                <DnsRecordCard type="A" name="a" value="203.0.113.7" status="conflict" />
            )
        ).toContain("Points elsewhere");
    });

    it("lists extra fields a form asks for", () => {
        const html = renderToStaticMarkup(
            <DnsRecordCard
                type="MX"
                name="example.test"
                value="mail.example.test"
                fields={[{ label: "Priority", value: "10" }]}
            />
        );
        expect(html).toContain("Priority");
        expect(html).toContain('aria-label="Copy priority 10"');
    });
});

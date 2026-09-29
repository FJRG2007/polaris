/**
 * A zone's records, in Spanish.
 *
 * The table is what every domain owner opens; the field problems are what a
 * migration misses, because they are written by the shared record schema and
 * only put into words by whoever reads them.
 */

import { describe, expect, it } from "vitest";
import { withMessages } from "../../setup/i18n";
import { translatorFor } from "@/lib/i18n/translate";
import { renderToStaticMarkup } from "react-dom/server";
import type { DnsRecordView } from "@/lib/dns/zone-records";
import { emptyDraft, recordFields } from "@/lib/dns/record-schema";
import { DnsRecordsTable } from "@/components/dns/dns-records-table";

const www: DnsRecordView = {
    id: "a",
    type: "A",
    relative: "www",
    name: "www.example.test",
    content: "203.0.113.10",
    ttl: 1,
    proxied: true,
    proxiable: true,
    priority: null,
    draft: emptyDraft("A")
};

describe("the records table", () => {
    it("names its columns and its actions in Spanish", () => {
        const markup = renderToStaticMarkup(
            withMessages(
                <DnsRecordsTable
                    records={[www]}
                    pending={new Set()}
                    checking={null}
                    empty="-"
                    onCheck={() => undefined}
                    onEdit={() => undefined}
                    onDelete={() => undefined}
                />,
                "es-ES"
            )
        );
        expect(markup).toContain("Contenido");
        expect(markup).toContain("Con proxy");
        expect(markup).toContain('aria-label="Eliminar el registro A www"');
        expect(markup).not.toContain("Proxied");
    });
});

describe("a record that cannot be saved", () => {
    it("says what is wrong with a field in Spanish", () => {
        const t = translatorFor("es-ES", "dns");
        const draft = { ...emptyDraft("A"), name: "www", content: "not an address" };
        const checked = recordFields(draft, "example.test", {}, t);
        expect(checked.ok).toBe(false);
        if (checked.ok) return;
        const said = Object.values(checked.problems).join(" ");
        expect(said.length).toBeGreaterThan(0);
        expect(said).not.toMatch(/\b(the|an|address)\b/i);
    });
});

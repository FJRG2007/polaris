/**
 * One evidence area on screen: what names a record opens it, a date is written
 * by the reader's format, and somebody whose account is gone is named without a
 * link to a page that would not open.
 */

import { readings } from "./fixtures";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildEvidence, type EvidenceSection } from "@/lib/compliance/evidence";
import { EvidenceSectionCard } from "@/app/(app)/admin/evidence/evidence-section";

const formatDate = (iso: string) => `[${iso.slice(0, 10)}]`;

function render(section: EvidenceSection): string {
    return renderToStaticMarkup(<EvidenceSectionCard section={section} formatDate={formatDate} />);
}

function area(id: EvidenceSection["id"], overrides = readings()): EvidenceSection {
    const found = buildEvidence(overrides).sections.find((entry) => entry.id === id);
    if (!found) throw new Error(`no ${id}`);
    return found;
}

describe("an evidence area", () => {
    it("links to where it is set and to whoever changed it last", () => {
        const html = render(area("authentication"));
        expect(html).toContain('href="/admin/security"');
        expect(html).toContain('href="/admin/users/00000000-0000-4000-8000-000000000001"');
        expect(html).toContain("Last changed [2026-09-01] by");
    });

    it("opens each listed record and writes its dates in the reader's format", () => {
        const html = render(area("backups"));
        expect(html).toContain('href="/apps/backups/00000000-0000-4000-8000-0000000000b1"');
        expect(html).toContain("[2026-09-10]");
    });

    it("names a former member without a link", () => {
        const base = readings();
        const html = render(
            area(
                "authentication",
                readings({
                    changes: {
                        ...base.changes,
                        authentication: {
                            at: "2026-09-01T09:30:00.000Z",
                            action: "instance.security.updated",
                            actorId: "00000000-0000-4000-8000-00000000dead",
                            actorName: "a former member",
                            actorExists: false
                        }
                    }
                })
            )
        );
        expect(html).toContain("a former member");
        expect(html).not.toContain("00000000dead");
    });

    it("says when the trail holds no change for it", () => {
        expect(render(area("firewall"))).toContain("No change to this is recorded in the audit trail.");
    });
});

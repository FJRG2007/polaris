/** The access log exported: every row, and nothing a spreadsheet would run. */

import { describe, expect, it } from "vitest";
import { csvCell, usesCsv } from "@/lib/access/grant-use-csv";

describe("the access log as CSV", () => {
    it("quotes every cell and defuses a formula", () => {
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
        expect(csvCell("@cmd")).toBe(`"'@cmd"`);
    });

    it("writes a header and one line per use", () => {
        const csv = usesCsv([
            {
                id: "1",
                at: "2026-05-09T10:00:00.000Z",
                grantId: "g1",
                who: "",
                link: true,
                linkNote: "Room 12 guest",
                targetType: "device",
                targetId: "d1",
                action: "unlock",
                outcome: "done",
                reason: ""
            }
        ]);
        const lines = csv.trim().split("\r\n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe("at,who,link,for,target,targetId,action,outcome,reason,grant");
        expect(lines[1]).toContain('"Room 12 guest"');
    });
});

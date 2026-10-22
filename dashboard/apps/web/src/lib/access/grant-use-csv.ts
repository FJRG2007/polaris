/** The access log as a CSV a spreadsheet opens safely. */

import type { GrantUseView } from "@/lib/access/grants";

/** A cell a spreadsheet will not run: quoted, and a leading formula sign
 *  defused (OWASP CSV injection). */
export function csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
}

export function usesCsv(uses: readonly GrantUseView[]): string {
    const head = [
        "at",
        "who",
        "link",
        "for",
        "target",
        "targetId",
        "action",
        "outcome",
        "reason",
        "grant"
    ];
    const lines = uses.map((use) =>
        [
            use.at,
            use.who,
            use.link ? "yes" : "no",
            use.linkNote,
            use.targetType,
            use.targetId,
            use.action,
            use.outcome,
            use.reason,
            use.grantId ?? ""
        ]
            .map(csvCell)
            .join(",")
    );
    return [head.join(","), ...lines].join("\r\n") + "\r\n";
}

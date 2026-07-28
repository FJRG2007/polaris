/**
 * Taking two-factor backup codes out of the browser. They are shown exactly once,
 * so the dialog offers every reasonable way to keep them: a plain list, machine
 * formats, a printable page, and a PDF.
 *
 * The PDF is written by hand rather than pulled from a library. It is a single
 * page of ASCII text in a standard font, which is a few dozen lines of PDF
 * syntax - not worth a dependency, and one less package handling secrets.
 */

export type BackupCodeFormat = "txt" | "json" | "csv" | "pdf";

const TITLE = "Polaris backup codes";
const NOTE = "Each code works once. Keep this somewhere only you can reach.";

export const BACKUP_CODE_FORMATS: ReadonlyArray<{ format: BackupCodeFormat; label: string }> = [
    { format: "txt", label: "Text (.txt)" },
    { format: "json", label: "JSON (.json)" },
    { format: "csv", label: "CSV (.csv)" },
    { format: "pdf", label: "PDF (.pdf)" }
];

const MIME: Readonly<Record<BackupCodeFormat, string>> = {
    txt: "text/plain;charset=utf-8",
    json: "application/json;charset=utf-8",
    csv: "text/csv;charset=utf-8",
    pdf: "application/pdf"
};

/** Codes are alphanumeric with a dash; anything else would break the PDF's font. */
function ascii(value: string): string {
    // eslint-disable-next-line no-control-regex
    return value.replace(/[^\x20-\x7E]/g, "?");
}

function textBody(codes: readonly string[], issuedAt: Date): string {
    return [`${TITLE}`, NOTE, `Issued ${issuedAt.toISOString()}`, "", ...codes].join("\n");
}

function csvBody(codes: readonly string[]): string {
    return ["code", ...codes].join("\n");
}

function jsonBody(codes: readonly string[], issuedAt: Date): string {
    return JSON.stringify({ issuedAt: issuedAt.toISOString(), codes }, null, 2);
}

/** Escape the three characters that are syntax inside a PDF string literal. */
function pdfString(value: string): string {
    return ascii(value).replace(/([\\()])/g, "\\$1");
}

/**
 * A one-page PDF holding the codes. Offsets in the cross-reference table are
 * byte counts, and every byte written here is ASCII, so string length is the
 * byte length.
 */
function pdfBody(codes: readonly string[], issuedAt: Date): string {
    const lines = [TITLE, NOTE, `Issued ${issuedAt.toISOString()}`, "", ...codes];
    const content = [
        "BT",
        "/F1 12 Tf",
        "56 780 Td",
        "18 TL",
        ...lines.map((line) => `(${pdfString(line)}) Tj T*`),
        "ET"
    ].join("\n");

    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
            "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    ];

    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((object, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });

    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return pdf;
}

/** The file to hand the browser for one format. */
export function backupCodesFile(
    codes: readonly string[],
    format: BackupCodeFormat,
    issuedAt = new Date()
): { name: string; type: string; body: string } {
    const body =
        format === "json" ? jsonBody(codes, issuedAt)
        : format === "csv" ? csvBody(codes)
        : format === "pdf" ? pdfBody(codes, issuedAt)
        : textBody(codes, issuedAt);
    return { name: `polaris-backup-codes.${format}`, type: MIME[format], body };
}

/** The printable page, rendered into a hidden frame so no popup is involved. */
export function backupCodesHtml(codes: readonly string[]): string {
    const items = codes.map((code) => `<li>${ascii(code)}</li>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 40px; color: #000; }
h1 { font-size: 18px; margin: 0 0 4px; }
p { font-size: 12px; margin: 0 0 16px; }
ol { font-family: ui-monospace, monospace; font-size: 14px; columns: 2; }
li { margin-bottom: 6px; }
</style></head><body><h1>${TITLE}</h1><p>${NOTE}</p><ol>${items}</ol></body></html>`;
}

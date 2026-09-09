/**
 * Turning a document into something somebody else's program can open.
 *
 * The part that has no I/O in it: given the plain shapes an editor keeps -
 * blocks of text, a grid of cells, slides of boxes - this answers with the bytes
 * of a text format, or with the model a binary writer then packs. Pure, so what
 * lands in somebody's Downloads folder can be asserted without a browser, a
 * spreadsheet engine or a zip.
 *
 * The rule the whole file follows: **an export is read by a stranger's
 * program.** Not by Polaris, not next week by us - by Excel on a machine we
 * have never seen, opening a file we have one chance to get right. So the
 * escaping is the interesting part and everything else is arrangement.
 */

/** One block of a document, flattened out of the editor's tree. */
export interface DocBlock {
    /** "p" for a paragraph, "h1".."h6" for a heading, "li" for a bulleted list
     *  item, "oli" for a numbered one, "code" for a code block, "quote" for a
     *  quotation.
     *
     *  The two kinds of list item are two kinds because the difference is what
     *  the document SAYS rather than how it looks: a procedure whose steps
     *  arrive as bullets stops saying that they are in an order. */
    readonly kind: string;
    readonly text: string;
}

/* -------------------------------------------------------------------------- */
/* Comma-separated values                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One field, escaped.
 *
 * Quoted whenever it holds a comma, a quote, a newline or leading or trailing
 * space, and quotes inside are doubled - which is the whole of RFC 4180 and the
 * whole of what goes wrong when somebody writes their own.
 *
 * The leading-formula guard is the one nobody expects and the one that matters:
 * a cell beginning `=`, `+`, `-`, `@`, tab or carriage return is executed by
 * Excel when the file is opened. A comparison whose "notes" column somebody
 * filled in with `=cmd|...` is a spreadsheet that runs it on the machine of
 * whoever it was sent to. The apostrophe is what every careful exporter writes,
 * and it is why this function exists rather than a template string.
 */
export function csvField(value: string): string {
    const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]|^\s|\s$/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** A whole sheet, as a file. CRLF between rows, which is what the format says
 *  and what the older readers still insist on. */
export function toCsv(rows: readonly (readonly string[])[]): string {
    return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The characters that mean something at the start of a Markdown line, escaped so
 * a paragraph beginning "1. " does not become a numbered list.
 *
 * Two shapes and they escape differently, which is the detail worth writing
 * down: a bullet or a heading is escaped in front of the character itself, and a
 * numbered list is escaped in front of its punctuation - `1\.`, never `\1.`,
 * because the digit is not what makes it a list.
 */
function escapeMarkdown(text: string): string {
    return text
        .replace(/^(\s*)([#>\-*+])(\s)/, "$1\\$2$3")
        .replace(/^(\s*)(\d+)([.)])(\s)/, "$1$2\\$3$4");
}

/** A document, as Markdown. */
export function toMarkdown(title: string, blocks: readonly DocBlock[]): string {
    const lines: string[] = [];
    if (title.trim()) lines.push(`# ${title.trim()}`, "");
    // Where a numbered list has got to. Reset by anything that is not one of
    // its items, because two procedures separated by a paragraph are two
    // procedures and the second one starts at 1.
    let counted = 0;
    for (const block of blocks) {
        const text = block.text.trim();
        if (!text) {
            continue;
        }
        counted = block.kind === "oli" ? counted + 1 : 0;
        if (/^h[1-6]$/.test(block.kind)) {
            lines.push(`${"#".repeat(Number(block.kind.slice(1)))} ${text}`, "");
        } else if (block.kind === "li") {
            lines.push(`- ${escapeMarkdown(text)}`);
        } else if (block.kind === "oli") {
            lines.push(`${counted}. ${escapeMarkdown(text)}`);
        } else if (block.kind === "quote") {
            lines.push(`> ${text}`, "");
        } else if (block.kind === "code") {
            lines.push("```", text, "```", "");
        } else {
            lines.push(escapeMarkdown(text), "");
        }
    }
    return `${lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd()}\n`;
}

/** A table, as Markdown. The separator row is what makes it a table rather than
 *  three lines of pipes, and a cell holding a pipe would end the column - so it
 *  is escaped. */
export function tableToMarkdown(rows: readonly (readonly string[])[]): string {
    if (rows.length === 0) return "";
    const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n+/g, " ");
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row: readonly string[]): string[] => [
        ...row.map(cell),
        ...Array.from({ length: width - row.length }, () => "")
    ];
    const [head, ...body] = rows;
    return [
        `| ${pad(head!).join(" | ")} |`,
        `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
        ...body.map((row) => `| ${pad(row).join(" | ")} |`)
    ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* HTML                                                                        */
/* -------------------------------------------------------------------------- */

/** Text, safe to put between tags. Five characters, and all five matter: an
 *  export is opened in a browser, and a document whose text somebody chose is
 *  markup unless this runs. */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * A document, as a page.
 *
 * Standalone and styled inline: an exported file is opened from a Downloads
 * folder with no stylesheet beside it, and one that arrives as unstyled Times
 * New Roman reads as broken rather than as plain.
 */
export function toHtml(title: string, blocks: readonly DocBlock[]): string {
    const body: string[] = [];
    let list: string[] | null = null;
    let listTag: "ul" | "ol" = "ul";
    const closeList = (): void => {
        if (!list) return;
        body.push(`<${listTag}>${list.join("")}</${listTag}>`);
        list = null;
    };

    for (const block of blocks) {
        const text = block.text.trim();
        if (!text) continue;
        if (block.kind === "li" || block.kind === "oli") {
            const tag = block.kind === "li" ? "ul" : "ol";
            // A bulleted list running into a numbered one is two lists, and
            // putting the second one's items inside the first would draw them
            // with the wrong marker.
            if (listTag !== tag) closeList();
            listTag = tag;
            list = list ?? [];
            list.push(`<li>${escapeHtml(text)}</li>`);
            continue;
        }
        closeList();
        if (/^h[1-6]$/.test(block.kind)) {
            body.push(`<${block.kind}>${escapeHtml(text)}</${block.kind}>`);
        } else if (block.kind === "quote") {
            body.push(`<blockquote>${escapeHtml(text)}</blockquote>`);
        } else if (block.kind === "code") {
            body.push(`<pre><code>${escapeHtml(text)}</code></pre>`);
        } else {
            body.push(`<p>${escapeHtml(text)}</p>`);
        }
    }
    closeList();

    return [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        `<title>${escapeHtml(title)}</title>`,
        "<style>",
        "body{max-width:46rem;margin:3rem auto;padding:0 1.25rem;",
        "font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b}",
        "h1,h2,h3,h4,h5,h6{line-height:1.25;margin:2rem 0 .75rem}",
        "blockquote{margin:1rem 0;padding-left:1rem;border-left:3px solid #d4d4d8;color:#52525b}",
        "pre{background:#f4f4f5;padding:.75rem 1rem;border-radius:.5rem;overflow-x:auto}",
        "table{border-collapse:collapse;width:100%}",
        "th,td{border:1px solid #d4d4d8;padding:.4rem .6rem;text-align:left;vertical-align:top}",
        "</style>",
        "</head>",
        "<body>",
        `<h1>${escapeHtml(title)}</h1>`,
        ...body,
        "</body>",
        "</html>",
        ""
    ].join("\n");
}

/** A table, as a page. For the two kinds whose export is a grid rather than
 *  prose. */
export function tableToHtml(title: string, rows: readonly (readonly string[])[]): string {
    const cells = (row: readonly string[], tag: "th" | "td"): string =>
        row.map((one) => `<${tag}>${escapeHtml(one)}</${tag}>`).join("");
    const [head, ...body] = rows;
    const table = head
        ? [
              "<table>",
              `<thead><tr>${cells(head, "th")}</tr></thead>`,
              "<tbody>",
              ...body.map((row) => `<tr>${cells(row, "td")}</tr>`),
              "</tbody>",
              "</table>"
          ].join("\n")
        : "";
    return toHtml(title, []).replace("</body>", `${table}\n</body>`);
}

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the file is called.
 *
 * The document's own name, because that is what somebody will look for in their
 * Downloads folder - reduced to what every filesystem takes, and never to
 * nothing. A name is handed to a browser in a header, so a newline or a quote in
 * it would be a header somebody else wrote, and a run of dots would be a name
 * that walks up a directory.
 */
export function exportFilename(title: string, extension: string): string {
    const named = title
        .replace(/[^a-zA-Z0-9 ._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80)
        .replace(/\.{2,}/g, ".")
        .replace(/^[.-]+|[.-]+$/g, "");
    return `${named || "document"}.${extension}`;
}

/** What each export is served as. `octet-stream` is deliberate for anything a
 *  browser would otherwise try to render: an export is content from inside the
 *  document, and a document is written by whoever wrote it. */
export const OFFICE_EXPORT_TYPES: Readonly<Record<string, string>> = {
    csv: "text/csv; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    html: "application/octet-stream",
    svg: "application/octet-stream",
    png: "image/png",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

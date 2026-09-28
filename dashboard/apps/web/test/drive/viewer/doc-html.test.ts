// @vitest-environment jsdom
/**
 * The Word reading view puts mammoth's HTML on the page, and mammoth copies a
 * hyperlink's target out of the package as written. A `.docx` from a mail, a
 * chat or a share can therefore carry a `javascript:` link that runs on this
 * origin when pressed. The document here is built the way such a file is, and
 * what reaches the page must keep its links and pictures and lose the script.
 */

import JSZip from "jszip";
import mammoth from "mammoth";
import { describe, expect, it } from "vitest";
import { sanitizeDocHtml } from "../../../src/app/(app)/drive/viewer/doc-html";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const LINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

async function docxWithLinks(links: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    );
    zip.file(
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    );
    const ids = Object.keys(links);
    zip.file(
        "word/_rels/document.xml.rels",
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ids
            .map((id) => `<Relationship Id="${id}" Type="${LINK}" Target="${links[id]}" TargetMode="External"/>`)
            .join("")}</Relationships>`
    );
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${ids
            .map((id) => `<w:p><w:hyperlink r:id="${id}"><w:r><w:t>link ${id}</w:t></w:r></w:hyperlink></w:p>`)
            .join("")}</w:body></w:document>`
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

describe("sanitizeDocHtml", () => {
    it("drops a javascript: link target mammoth passes through, and keeps the text", async () => {
        const buffer = await docxWithLinks({ rId5: "javascript:alert(document.domain)" });
        const raw = (await mammoth.convertToHtml({ buffer })).value;
        // What the page used to receive.
        expect(raw).toContain('href="javascript:alert(document.domain)"');

        const safe = await sanitizeDocHtml(raw);
        expect(safe).not.toMatch(/javascript:/i);
        expect(safe).toContain("link rId5");
    });

    it("keeps web links and embedded pictures", async () => {
        const buffer = await docxWithLinks({ rId6: "https://example.com/page" });
        const raw = (await mammoth.convertToHtml({ buffer })).value;
        const safe = await sanitizeDocHtml(`${raw}<img src="data:image/png;base64,iVBORw0KGgo=" alt="">`);
        expect(safe).toContain('href="https://example.com/page"');
        expect(safe).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    });

    it("strips markup that would run or load on its own", async () => {
        const safe = await sanitizeDocHtml(
            '<p>ok</p><img src="x" onerror="alert(1)"><script>alert(2)</script><iframe src="javascript:alert(3)"></iframe>'
        );
        expect(safe).not.toMatch(/onerror|<script|<iframe|alert/i);
        expect(safe).toContain("<p>ok</p>");
    });
});

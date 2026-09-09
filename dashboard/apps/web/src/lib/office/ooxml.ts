/**
 * A document or a deck, as the real Office package.
 *
 * `@polaris/docx` and `@polaris/pptx` are ported from GenOffice (Apache-2.0, see
 * NOTICE) and are the OOXML engines proper: a blank package they build has the
 * styles, the numbering, the sections, the master, the layout and the theme that
 * a reader other than the one it was tested against will go looking for.
 *
 * What was here before was a zip with the four parts that make a file open. It
 * opened, and it was a document with no styles in it - every heading the same
 * size as every paragraph, because a `w:pStyle` pointing at a style the package
 * does not contain is a style Word ignores.
 *
 * So the shape of both writers is the same: take the blank package the engine
 * builds, and put the content into it through the engine's own generator. The
 * package keeps everything that makes it a real one; the body is ours.
 */

import JSZip from "jszip";
import type * as core from "@polaris/core";

/** Where a body starts and ends in a Word document part. Written down because
 *  both the read and the write use it, and a mismatch is a file that opens
 *  empty. */
const BODY_OPEN = "<w:body>";
const BODY_CLOSE = "</w:body>";

/**
 * A document, as Word.
 *
 * The paragraphs go through `generateParagraphXml`, which is the same function
 * the engine uses when it saves a document somebody edited - so a heading is a
 * real Heading, a list item is a real list item against the numbering the blank
 * package carries, and a quotation is the Quote style rather than an indent.
 *
 * The section properties at the end of the body are kept. They are the page
 * size, the margins and the orientation, and a body written without them is a
 * document that opens as whatever the reader felt like.
 */
export async function writeDocx(
    title: string,
    blocks: readonly core.DocBlock[]
): Promise<Uint8Array> {
    const [
        { buildBlankDocx, generateParagraphXml, BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID },
        JSZipModule
    ] = await Promise.all([import("@polaris/docx"), Promise.resolve(JSZip)]);

    const zip = await JSZipModule.loadAsync(await buildBlankDocx());
    const part = zip.file("word/document.xml");
    if (!part) return buildBlankDocx();

    // The blank package's own numbering, which is what makes a list a list
    // rather than a paragraph beginning with a dash.
    const context = {
        headingStyleIds: new Map([
            [1, "Heading1"],
            [2, "Heading2"],
            [3, "Heading3"],
            [4, "Heading4"],
            [5, "Heading5"],
            [6, "Heading6"]
        ]),
        listParagraphStyleId: "ListParagraph",
        // No hyperlinks are generated here, so nothing ever asks for one. It is
        // required by the contract rather than by this caller.
        allocateHyperlinkRel: () => "rId1"
    };

    const asBlock = (kind: string, text: string) => {
        const runs = [{ text }];
        const heading = /^h([1-6])$/.exec(kind);
        if (heading) {
            return { type: "heading" as const, level: Number(heading[1]), runs };
        }
        // Both numberings the blank package carries, under the ids it gave
        // them: a numbered list written against the bullet one is a procedure
        // whose steps arrive as dashes.
        if (kind === "li" || kind === "oli") {
            const bulleted = kind === "li";
            return {
                type: "listItem" as const,
                level: 0,
                list: {
                    kind: bulleted ? ("bullet" as const) : ("ordered" as const),
                    numId: bulleted ? BLANK_BULLET_NUM_ID : BLANK_ORDERED_NUM_ID,
                    ilvl: 0
                },
                runs
            };
        }
        if (kind === "quote") return { type: "paragraph" as const, styleId: "Quote", runs };
        return { type: "paragraph" as const, runs };
    };

    const body = [
        generateParagraphXml(asBlock("h1", title) as never, context as never),
        ...blocks.map((block) =>
            generateParagraphXml(asBlock(block.kind, block.text) as never, context as never)
        )
    ].join("");

    const document = await part.async("string");
    const open = document.indexOf(BODY_OPEN);
    const close = document.lastIndexOf(BODY_CLOSE);
    if (open < 0 || close < 0) return buildBlankDocx();
    // Everything after the last paragraph and before the close is the section
    // properties. Kept rather than rewritten: it is the page.
    const tail = document.slice(open + BODY_OPEN.length, close);
    const section = tail.slice(tail.indexOf("<w:sectPr"));

    zip.file(
        "word/document.xml",
        `${document.slice(0, open + BODY_OPEN.length)}${body}${section}${document.slice(close)}`
    );
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/**
 * A deck, as PowerPoint.
 *
 * The blank package carries one slide, a layout, a master and a theme. Each
 * further slide is that slide with its text replaced and its own relationship
 * to the layout, which is what makes the deck open with a background and a font
 * rather than as white rectangles.
 *
 * Positions are deliberately not carried across. A box here is a fraction of the
 * slide and PowerPoint counts in EMUs; translating one into the other faithfully
 * is a layout engine rather than a multiplication, so what leaves is every word,
 * in order, on the right slide - which is what somebody exporting a deck to send
 * it actually needs.
 */
export async function writePptx(
    slides: readonly { notes: string; lines: string[] }[]
): Promise<Uint8Array> {
    const { createBlankPptx } = await import("@polaris/pptx");
    const kept = slides.length > 0 ? slides : [{ notes: "", lines: [] }];

    const zip = await JSZip.loadAsync(await createBlankPptx());
    const first = zip.file("ppt/slides/slide1.xml");
    const firstRels = zip.file("ppt/slides/_rels/slide1.xml.rels");
    if (!first || !firstRels) return createBlankPptx();

    const template = await first.async("string");
    const rels = await firstRels.async("string");

    /** One slide's XML: the blank slide with a text box of these lines in it. */
    const slideXml = (lines: readonly string[]): string => {
        const paragraphs = (lines.length > 0 ? lines : [""])
            .map((line) => `<a:p><a:r><a:t>${escapeXml(line)}</a:t></a:r></a:p>`)
            .join("");
        const shape = [
            "<p:sp><p:nvSpPr><p:cNvPr id='2' name='Text'/><p:cNvSpPr txBox='1'/><p:nvPr/></p:nvSpPr>",
            "<p:spPr><a:xfrm><a:off x='838200' y='838200'/><a:ext cx='10515600' cy='5181600'/></a:xfrm>",
            "<a:prstGeom prst='rect'><a:avLst/></a:prstGeom></p:spPr>",
            `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
        ].join("");
        // Before the tree closes, so the box is a child of the shape tree rather
        // than a sibling of the slide.
        return template.replace("</p:spTree>", `${shape}</p:spTree>`);
    };

    kept.forEach((slide, index) => {
        const at = index + 1;
        zip.file(`ppt/slides/slide${at}.xml`, slideXml(slide.lines));
        zip.file(`ppt/slides/_rels/slide${at}.xml.rels`, rels);
    });

    // Every slide named in the presentation and in its relationships, or a deck
    // of one slide is what opens however many were written.
    const presentationPart = zip.file("ppt/presentation.xml");
    const presentationRels = zip.file("ppt/_rels/presentation.xml.rels");
    if (presentationPart && presentationRels) {
        const ids = kept
            .map((_, index) => `<p:sldId id='${256 + index}' r:id='rIdSlide${index + 1}'/>`)
            .join("");
        const presentation = (await presentationPart.async("string")).replace(
            /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
            `<p:sldIdLst>${ids}</p:sldIdLst>`
        );
        zip.file("ppt/presentation.xml", presentation);

        const links = kept
            .map(
                (_, index) =>
                    `<Relationship Id='rIdSlide${index + 1}' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide' Target='slides/slide${index + 1}.xml'/>`
            )
            .join("");
        const relsXml = (await presentationRels.async("string")).replace(
            /<Relationship[^>]*relationships\/slide"[^>]*\/>/g,
            ""
        );
        zip.file(
            "ppt/_rels/presentation.xml.rels",
            relsXml.replace("</Relationships>", `${links}</Relationships>`)
        );
    }

    // Every slide past the first needs its content type declared, or a reader
    // refuses the package rather than the slide.
    const typesPart = zip.file("[Content_Types].xml");
    if (typesPart) {
        const overrides = kept
            .slice(1)
            .map(
                (_, index) =>
                    `<Override PartName='/ppt/slides/slide${index + 2}.xml' ContentType='application/vnd.openxmlformats-officedocument.presentationml.slide+xml'/>`
            )
            .join("");
        const types = (await typesPart.async("string")).replace("</Types>", `${overrides}</Types>`);
        zip.file("[Content_Types].xml", types);
    }

    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** Text, safe inside an XML element. The same five as HTML: a part is XML, and a
 *  document whose text holds `<` is a file every reader refuses to open. */
function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

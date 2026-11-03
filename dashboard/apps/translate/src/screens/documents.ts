/**
 * A document taken apart into the text to translate, and put back together
 * with the translation in place - all in the browser.
 *
 * Word, PowerPoint and Excel files are zips of XML (ECMA-376). Each paragraph
 * (`w:p`, `a:p`, a shared string `si`) is translated whole, as Google
 * Translate's document mode does, and the translation is written into its
 * first run with the others emptied, so the paragraph keeps its style, its
 * place on the page or slide, and its cell; only formatting that changed
 * within one paragraph is flattened to the first run's. Everything else in
 * the file - images, tables, charts, layout - is copied untouched.
 *
 * A PDF has no paragraphs to write back into, so it is read page by page
 * (pdf.js, the same copy the Drive viewer serves) and comes back as text.
 * Plain text comes back as plain text.
 */

import { sniffDocument } from "../model/media";

export type DocumentFormat = "docx" | "pptx" | "xlsx" | "pdf" | "text";

/** Why a document could not be opened, as a code the screen has words for. */
export class DocumentError extends Error {
    public readonly code: "type" | "damaged";

    public constructor(code: "type" | "damaged") {
        super(`document ${code}`);
        this.name = "DocumentError";
        this.code = code;
    }
}

export interface DocumentJob {
    format: DocumentFormat;
    /** The texts to translate, in order. */
    segments: string[];
    /** The document again, with `translated[i]` in place of `segments[i]`. */
    build(translated: readonly string[]): Promise<Blob>;
    /** The extension the translated file is saved with. */
    extension: string;
}

interface Shape {
    format: "docx" | "pptx" | "xlsx";
    /** Whether a part of the zip holds text to translate. */
    part: RegExp;
    paragraph: string;
    text: string;
    /** An element whose text is not the paragraph's own (phonetic guides). */
    skip?: string;
    mime: string;
}

const SHAPES: readonly (Shape & { marker: string })[] = [
    {
        format: "docx",
        marker: "word/document.xml",
        part: /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/,
        paragraph: "w:p",
        text: "w:t",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    },
    {
        format: "pptx",
        marker: "ppt/presentation.xml",
        part: /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/,
        paragraph: "a:p",
        text: "a:t",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    },
    {
        format: "xlsx",
        marker: "xl/workbook.xml",
        part: /^xl\/sharedStrings\.xml$/,
        paragraph: "si",
        text: "t",
        skip: "rPh",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }
];

const XML_NS = "http://www.w3.org/XML/1998/namespace";

export interface XmlSegments {
    segments: string[];
    /** The part again with `translated[i]` in place of `segments[i]`. */
    apply(translated: readonly string[]): string;
}

/** The paragraphs of one XML part, and the way to write their translations back. */
export function xmlSegments(
    xml: string,
    shape: Pick<Shape, "paragraph" | "text" | "skip">
): XmlSegments {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) throw new DocumentError("damaged");
    const groups = new Map<Element, Element[]>();
    for (const node of Array.from(doc.getElementsByTagName(shape.text))) {
        let parent = node.parentElement;
        let skipped = false;
        while (parent && parent.tagName !== shape.paragraph) {
            if (shape.skip && parent.tagName === shape.skip) skipped = true;
            parent = parent.parentElement;
        }
        if (skipped || !parent) continue;
        const group = groups.get(parent);
        if (group) group.push(node);
        else groups.set(parent, [node]);
    }
    const kept = [...groups.values()].filter((nodes) =>
        nodes.some((node) => (node.textContent ?? "").trim())
    );
    const declaration = /^<\?xml[^>]*\?>/.exec(xml)?.[0] ?? "";
    return {
        segments: kept.map((nodes) => nodes.map((node) => node.textContent ?? "").join("")),
        apply(translated) {
            kept.forEach((nodes, index) => {
                nodes.forEach((node, at) => {
                    node.textContent = at === 0 ? (translated[index] ?? "") : "";
                });
                // Spaces at either end of a run are dropped unless it says to keep them.
                nodes[0]?.setAttributeNS(XML_NS, "xml:space", "preserve");
            });
            const out = new XMLSerializer().serializeToString(doc);
            return declaration && !out.startsWith("<?xml") ? `${declaration}${out}` : out;
        }
    };
}

async function openOffice(bytes: Uint8Array): Promise<DocumentJob> {
    const { default: JSZip } = await import("jszip");
    let zip: InstanceType<typeof JSZip>;
    try {
        zip = await JSZip.loadAsync(bytes);
    } catch {
        throw new DocumentError("damaged");
    }
    const shape = SHAPES.find((candidate) => zip.file(candidate.marker));
    if (!shape) throw new DocumentError("type");
    const names = Object.keys(zip.files)
        .filter((name) => shape.part.test(name))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const parts: { name: string; read: XmlSegments }[] = [];
    for (const name of names) {
        const xml = await zip.file(name)!.async("string");
        parts.push({ name, read: xmlSegments(xml, shape) });
    }
    return {
        format: shape.format,
        extension: `.${shape.format}`,
        segments: parts.flatMap((part) => part.read.segments),
        async build(translated) {
            let at = 0;
            for (const part of parts) {
                const count = part.read.segments.length;
                zip.file(part.name, part.read.apply(translated.slice(at, at + count)));
                at += count;
            }
            return zip.generateAsync({ type: "blob", mimeType: shape.mime, compression: "DEFLATE" });
        }
    };
}

/** Where the page's pdf.js worker is: the copy the dashboard stages for its PDF viewer. */
const PDF_WORKER = "/pdfjs/pdf.worker.min.mjs";

async function openPdf(bytes: Uint8Array): Promise<DocumentJob> {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    let pages: string[];
    try {
        const task = pdfjs.getDocument({ data: bytes });
        const doc = await task.promise;
        pages = [];
        for (let number = 1; number <= doc.numPages; number++) {
            const content = await (await doc.getPage(number)).getTextContent();
            let text = "";
            for (const item of content.items) {
                if (!("str" in item)) continue;
                text += item.str + (item.hasEOL ? "\n" : "");
            }
            pages.push(text.trim());
        }
        await task.destroy();
    } catch {
        throw new DocumentError("damaged");
    }
    return {
        format: "pdf",
        extension: ".txt",
        segments: pages,
        async build(translated) {
            // A form feed between pages: the plain-text page break.
            return new Blob([translated.join("\n\f\n")], { type: "text/plain;charset=utf-8" });
        }
    };
}

function openText(bytes: Uint8Array): DocumentJob {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new DocumentError("type");
    }
    return {
        format: "text",
        extension: ".txt",
        segments: [text],
        async build(translated) {
            return new Blob([translated[0] ?? ""], { type: "text/plain;charset=utf-8" });
        }
    };
}

/** A document's text and the way to rebuild it, whatever the file claims to be. */
export async function openDocument(bytes: Uint8Array): Promise<DocumentJob> {
    const kind = sniffDocument(bytes);
    if (kind === "zip") return openOffice(bytes);
    if (kind === "pdf") return openPdf(bytes);
    if (kind === "text") return openText(bytes);
    throw new DocumentError("type");
}

/** The name the translation is saved under: the original's, tagged with the language. */
export function translatedName(original: string, language: string, extension: string): string {
    const base = original.replace(/\.[^./\\]+$/, "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_") || "document";
    return `${base}.${language}${extension}`;
}

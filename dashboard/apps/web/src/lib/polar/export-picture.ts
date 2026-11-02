/**
 * A chat as a picture or a PDF, drawn in the browser.
 *
 * Here rather than on the server because the server image carries no fonts: what it
 * drew would be boxes for most of the world's writing, while the reader's browser has
 * theirs. The exported HTML is laid out in a shadow root to measure it, wrapped in an
 * SVG, and drawn on a canvas. A PDF is that drawing cut into A4 pages between lines, so
 * its text can't be selected: there is no PDF writer in Polaris, and the HTML is the export to
 * reach for to copy from.
 *
 * Browser-only.
 */

import DOMPurify from "dompurify";

export type PictureFormat = "png" | "jpg" | "webp" | "svg" | "pdf";

const WIDTH = 820;
const SCALE = 2;
/** Tallest canvas browsers agree to draw, in device pixels. */
const CANVAS_MOST = 16_000;
/** A4 at this width, in CSS pixels. */
const PAGE_HEIGHT = Math.round((WIDTH * 297) / 210);
const JPEG_QUALITY = 0.86;
const PDF_PAGE_WIDTH = 595.28;
const PDF_PAGE_HEIGHT = 841.89;

/** The chat is taller than a canvas: the screen offers the PDF, which is cut in pages. */
export class PictureTooTall extends Error {
    override name = "PictureTooTall";
}

const MIME: Record<"png" | "jpg" | "webp", string> = {
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp"
};

/** Characters XML 1.0 forbids, which HTML lets through: a terminal's escape codes pasted
 *  into a chat are enough to make the whole drawing unreadable. */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/gu;

/** The span one line of text takes on the drawing, in CSS pixels. */
interface LineSpan {
    readonly top: number;
    readonly bottom: number;
}

interface Drawing {
    readonly svg: string;
    readonly height: number;
    readonly lines: readonly LineSpan[];
}

/** Where each line of laid-out text sits, measured from the top of `body`. */
function linesOf(body: HTMLElement): LineSpan[] {
    const origin = body.getBoundingClientRect().top;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const lines: LineSpan[] = [];
    while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue;
        range.selectNodeContents(walker.currentNode);
        for (const rect of Array.from(range.getClientRects())) {
            lines.push({ top: rect.top - origin, bottom: rect.bottom - origin });
        }
    }
    return lines;
}

/**
 * Where each PDF page starts: at the top of the last line that fits, so no line is cut
 * through. Only a stretch taller than a page with no gap in it is cut where it falls.
 */
export function pageTops(
    lines: readonly LineSpan[],
    height: number,
    pageHeight = PAGE_HEIGHT
): number[] {
    const gaps: number[] = [];
    let reached = 0;
    for (const line of [...lines].sort((left, right) => left.top - right.top)) {
        if (line.top >= reached) gaps.push(Math.floor(line.top));
        reached = Math.max(reached, line.bottom);
    }
    const tops = [0];
    let top = 0;
    let index = 0;
    while (top + pageHeight < height) {
        const limit = top + pageHeight;
        let next = limit;
        for (; index < gaps.length && (gaps[index] as number) <= limit; index += 1) {
            if ((gaps[index] as number) > top) next = gaps[index] as number;
        }
        top = next;
        tops.push(top);
    }
    return tops;
}

/** The export's page as an SVG. Pictures are left out: one from elsewhere would never
 *  load inside an image, and loading it would be a request nobody asked for. */
function drawingOf(html: string): Drawing {
    const page = new DOMParser().parseFromString(html, "text/html");
    const style = page.querySelector("style")?.textContent ?? "";
    const clean = DOMPurify.sanitize(page.body.innerHTML, {
        RETURN_DOM: true,
        FORBID_TAGS: ["img", "video", "audio", "iframe", "style", "svg", "math"]
    });
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;left:-99999px;top:0;width:${WIDTH}px;visibility:hidden`;
    const root = host.attachShadow({ mode: "closed" });
    const sheet = document.createElement("style");
    sheet.textContent = style;
    const body = document.createElement("div");
    body.className = "page";
    body.append(...Array.from(clean.childNodes));
    root.append(sheet, body);
    document.body.append(host);
    const height = Math.ceil(body.getBoundingClientRect().height);
    const lines = linesOf(body);
    host.remove();
    const xhtml = new XMLSerializer().serializeToString(body).replace(NOT_XML, "");
    const css = sheet.outerHTML.replace("<style>", '<style xmlns="http://www.w3.org/1999/xhtml">');
    return {
        height,
        lines,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${css}${xhtml}</div></foreignObject></svg>`
    };
}

/** As a data address, since a blob's would taint the canvas. */
function imageOf(svg: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("The drawing did not load."));
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                // A browser that cannot write a type silently writes PNG instead.
                if (blob?.type === type) resolve(blob);
                else reject(new Error(`This browser cannot write ${type}.`));
            },
            type,
            JPEG_QUALITY
        );
    });
}

/** A slice of the drawing on white, which JPEG needs and a dark viewer wants. */
function slice(image: HTMLImageElement, top: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH * SCALE;
    canvas.height = height * SCALE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.scale(SCALE, SCALE);
    context.drawImage(image, 0, -top);
    return canvas;
}

/** A PDF of one full-page JPEG per page: the format's smallest honest form. */
export function pdfOfJpegs(
    pages: readonly { jpeg: Uint8Array; width: number; height: number; drawn: number }[]
): Blob {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let at = 0;
    const put = (chunk: string | Uint8Array) => {
        const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
        chunks.push(bytes);
        at += bytes.length;
    };
    const object = (id: number, write: () => void) => {
        offsets[id] = at;
        put(`${id} 0 obj\n`);
        write();
        put("\nendobj\n");
    };
    put("%PDF-1.4\n");
    const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
    object(1, () => put("<< /Type /Catalog /Pages 2 0 R >>"));
    object(2, () => put(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`));
    pages.forEach((page, index) => {
        const [pageId, imageId, contentId] = [3 + index * 3, 4 + index * 3, 5 + index * 3];
        const drawn = (PDF_PAGE_WIDTH * page.drawn) / WIDTH;
        const content = `q ${PDF_PAGE_WIDTH} 0 0 ${drawn} 0 ${PDF_PAGE_HEIGHT - drawn} cm /Im Do Q`;
        object(pageId, () =>
            put(
                `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /XObject << /Im ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`
            )
        );
        object(imageId, () => {
            put(
                `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
            );
            put(page.jpeg);
            put("\nendstream");
        });
        object(contentId, () =>
            put(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
        );
    });
    const count = 3 + pages.length * 3;
    const table = at;
    put(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id += 1) {
        put(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
    }
    put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`);
    return new Blob(chunks as BlobPart[], { type: "application/pdf" });
}

async function pdfOf(
    image: HTMLImageElement,
    height: number,
    lines: readonly LineSpan[]
): Promise<Blob> {
    const pages = [];
    const tops = pageTops(lines, height);
    for (const [index, top] of tops.entries()) {
        const drawn = (tops[index + 1] ?? height) - top;
        const canvas = slice(image, top, drawn);
        const jpeg = new Uint8Array(await (await canvasBlob(canvas, MIME.jpg)).arrayBuffer());
        pages.push({ jpeg, width: canvas.width, height: canvas.height, drawn });
    }
    return pdfOfJpegs(pages);
}

/** The file for one format, from the chat's HTML export. */
export async function pictureOf(html: string, format: PictureFormat): Promise<Blob> {
    const { svg, height, lines } = drawingOf(html);
    if (format === "svg") return new Blob([svg], { type: "image/svg+xml" });
    const image = await imageOf(svg);
    if (format === "pdf") return pdfOf(image, height, lines);
    if (height * SCALE > CANVAS_MOST) throw new PictureTooTall();
    return canvasBlob(slice(image, 0, height), MIME[format]);
}

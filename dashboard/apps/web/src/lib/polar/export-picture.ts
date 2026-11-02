/**
 * A chat as a picture or a PDF, drawn in the browser.
 *
 * Here rather than on the server because the server image carries no fonts: what it
 * drew would be boxes for most of the world's writing, while the reader's browser has
 * theirs. The exported HTML is laid out in a shadow root to measure it, wrapped in an
 * SVG, and drawn on a canvas. A PDF is that drawing cut into A4 pages, so its text
 * can't be selected: there is no PDF writer in Polaris, and the HTML is the export to
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

interface Drawing {
    readonly svg: string;
    readonly height: number;
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
    host.remove();
    const xhtml = new XMLSerializer().serializeToString(body);
    const css = sheet.outerHTML.replace("<style>", '<style xmlns="http://www.w3.org/1999/xhtml">');
    return {
        height,
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
        object(contentId, () => put(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
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

async function pdfOf(image: HTMLImageElement, height: number): Promise<Blob> {
    const pages = [];
    for (let top = 0; top < height; top += PAGE_HEIGHT) {
        const drawn = Math.min(PAGE_HEIGHT, height - top);
        const canvas = slice(image, top, drawn);
        const jpeg = new Uint8Array(await (await canvasBlob(canvas, MIME.jpg)).arrayBuffer());
        pages.push({ jpeg, width: canvas.width, height: canvas.height, drawn });
    }
    return pdfOfJpegs(pages);
}

/** The file for one format, from the chat's HTML export. */
export async function pictureOf(html: string, format: PictureFormat): Promise<Blob> {
    const { svg, height } = drawingOf(html);
    if (format === "svg") return new Blob([svg], { type: "image/svg+xml" });
    const image = await imageOf(svg);
    if (format === "pdf") return pdfOf(image, height);
    if (height * SCALE > CANVAS_MOST) throw new PictureTooTall();
    return canvasBlob(slice(image, 0, height), MIME[format]);
}

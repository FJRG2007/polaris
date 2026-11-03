/**
 * `/api/translate/website`: a web page, fetched by Polaris for the screen to
 * translate. POST `{ url }` (http or https) and get `{ url, html }`: the page's
 * HTML as text, never served as a page. The screen parses it inert, keeps the
 * readable text and its structure, and draws that itself; nothing on the page
 * runs.
 *
 * Fetched through the same guard every outside address goes through (no
 * private or local addresses, every redirect re-checked), size capped, signed
 * in and rate limited like the other translate routes. Never stored.
 */

import { host } from "@polaris/app-host";
import { translateT } from "../../../../lib/i18n";
import { body, caller } from "../../../../lib/route";
import { websiteRequest } from "../../../../model/input";

/** The most of a page read, in bytes. */
const PAGE_MAX_BYTES = 2 * 1024 * 1024;

/** How much of a page is searched for its own `<meta charset>`. */
const META_SNIFF_BYTES = 1024;

function decoderFor(label: string | undefined, fromPage = false): TextDecoder | null {
    if (!label) return null;
    const named = label.toLowerCase();
    try {
        return new TextDecoder(fromPage && named.startsWith("utf-16") ? "utf-8" : named);
    } catch {
        return null;
    }
}

/**
 * The page's text in its own encoding: a byte order mark, else the header's
 * charset, else the one the page declares in its first kilobyte
 * (`<meta charset>` or `http-equiv`), else UTF-8, the order the HTML spec
 * sniffs in.
 */
function decodePage(contentType: string, bytes: Uint8Array): string {
    const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, META_SNIFF_BYTES));
    const declared = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
    const marked =
        bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
            ? "utf-8"
            : bytes[0] === 0xfe && bytes[1] === 0xff
              ? "utf-16be"
              : bytes[0] === 0xff && bytes[1] === 0xfe
                ? "utf-16le"
                : undefined;
    const decoder =
        decoderFor(marked) ??
        decoderFor(/charset=["']?([\w.:-]+)/i.exec(contentType)?.[1]) ??
        decoderFor(declared, true) ??
        new TextDecoder("utf-8");
    return decoder.decode(bytes);
}

export async function POST(request: Request): Promise<Response> {
    const user = await caller();
    if (user instanceof Response) return user;
    const asked = await body(request, websiteRequest);
    if (asked instanceof Response) return asked;
    const t = await translateT();
    const refuse = (error: string, message: string, status: number) =>
        Response.json({ error, message }, { status });

    const url = await host.safeFetch.safeUrl(asked.url);
    if (!url) return refuse("invalid", t("website.invalid"), 400);
    let response: Awaited<ReturnType<typeof host.safeFetch.follow>>;
    try {
        response = await host.safeFetch.follow(url);
    } catch {
        response = null;
    }
    // i18n-ignore codes for the caller; `message` carries the words
    if (!response || response.status >= 400)
        return refuse("unreachable", t("website.unreachable"), 502);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        return refuse("unsupported", t("website.notPage"), 415);
    }
    const bytes = await host.safeFetch.readCapped(response, PAGE_MAX_BYTES);
    if (!bytes) return refuse("tooLarge", t("website.tooLarge"), 413);
    const html = decodePage(contentType, bytes);
    return Response.json(
        { url: url.toString(), html },
        { headers: { "cache-control": "no-store" } }
    );
}

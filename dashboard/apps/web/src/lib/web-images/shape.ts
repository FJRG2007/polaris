/**
 * What the picker's "Search the web" tab asks for and gets back.
 *
 * Shared by the route and the browser, so it holds no server code: the browser
 * validates the same query the route does, and both read one result shape.
 */

import { z } from "zod";

/** Longer than anybody types into an image search, short enough to bound a key. */
export const WEB_IMAGE_QUERY_MAX = 200;

/** Openverse answers at most 240 results to an anonymous caller (20 a page), so
 *  past page 12 there is nothing to ask for. */
export const WEB_IMAGE_PAGE_SIZE = 20;
export const WEB_IMAGE_MAX_PAGE = 12;

/** One spelling per question: surrounding and repeated spaces are not a
 *  different search, and neither is the letter case. */
export function normalizeWebImageQuery(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export const webImageSearchSchema = z.object({
    q: z
        .string()
        .transform(normalizeWebImageQuery)
        .pipe(z.string().min(1).max(WEB_IMAGE_QUERY_MAX)),
    page: z.coerce.number().int().min(1).max(WEB_IMAGE_MAX_PAGE).default(1),
    /** SafeSearch, on unless the reader turned it off. */
    safe: z
        .enum(["1", "0"])
        .default("1")
        .transform((value) => value === "1")
});

/** A result's id: the provider it came from and that provider's own id. Only
 *  these two shapes, so an id can never smuggle an address in. */
export const webImageIdSchema = z
    .string()
    .regex(/^(?:ov:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|wc:[1-9][0-9]{0,11})$/);

export const webImageFileSchema = z.object({
    id: webImageIdSchema,
    size: z.enum(["thumb", "full"]).default("thumb")
});

export type WebImageProvider = "openverse" | "wikimedia";

/** Who made it and on what terms, kept with the image wherever it goes. */
export interface WebImageCredit {
    readonly provider: WebImageProvider;
    readonly title: string;
    readonly creator: string;
    readonly creatorUrl: string;
    /** As the license names itself: "CC BY-SA 2.0", "Public domain". */
    readonly license: string;
    readonly licenseUrl: string;
    /** The page the image is published on. */
    readonly sourceUrl: string;
}

export interface WebImage {
    readonly id: string;
    readonly title: string;
    readonly width: number;
    readonly height: number;
    readonly credit: WebImageCredit;
}

export interface WebImagePage {
    readonly results: readonly WebImage[];
    readonly more: boolean;
}

/** Where the browser asks for an image's bytes. Always this server, never the
 *  host the image lives on, so the reader's address never reaches it. */
export function webImageAddress(id: string, size: "thumb" | "full"): string {
    return `/api/picker/web-images/image?id=${encodeURIComponent(id)}&size=${size}`;
}


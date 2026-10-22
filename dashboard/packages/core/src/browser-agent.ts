/**
 * Polar using the person's own browser, through the Polaris extension: the
 * commands the dashboard hands the extension and the answers it sends back.
 *
 * The shape is the one Claude in Chrome and Playwright MCP's extension mode
 * converged on: the tools run inside the browser the person is already signed
 * in to, so a page that needs their session reads, and the server only ever
 * receives what the page shows - never a cookie, a token or a stored value.
 * Elements are named by the refs a snapshot handed out (`e12`), the way
 * Playwright MCP's accessibility snapshot names them, rather than by a CSS
 * selector the model guessed.
 *
 * One module, imported by both ends: the dashboard parses what the extension
 * answers with these schemas, and the extension parses what the dashboard asks
 * with them, so neither trusts a shape it did not check.
 */

import { z } from "zod";

/** The most characters of a page one read hands back. */
export const BROWSER_TEXT_MOST = 30_000;
/** The most elements one snapshot lists. */
export const BROWSER_ELEMENTS_MOST = 200;
/** The most characters typed into one box in one call. */
export const BROWSER_TYPE_MOST = 4_000;

const tab = z.number().int().nonnegative();
const ref = z.string().regex(/^e\d{1,6}$/, "A ref from browser_find, like e12.");
/** The site an action is approved for, as the card names it: a bare host. */
const site = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+(:\d{1,5})?$/, "A site, like github.com.");
const address = z
    .string()
    .trim()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), "An http or https address.");

/** What the dashboard asks the extension to do. */
export const browserCommand = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("open"), url: address }),
    z.object({
        kind: z.literal("read"),
        tab,
        selector: z.string().trim().min(1).max(300).optional()
    }),
    z.object({ kind: z.literal("find"), tab, query: z.string().trim().max(200).optional() }),
    z.object({ kind: z.literal("click"), tab, ref, site }),
    z.object({
        kind: z.literal("type"),
        tab,
        ref,
        site,
        text: z.string().max(BROWSER_TYPE_MOST),
        submit: z.boolean().optional()
    }),
    z.object({ kind: z.literal("close"), tab })
]);
export type BrowserCommand = z.infer<typeof browserCommand>;

/** Why a command did not run, as a code the dashboard words for the model. */
export const BROWSER_REFUSALS = [
    /** The person said no to this site in the extension, or did not answer. */
    "site-denied",
    /** Polar may only touch tabs it opened itself. */
    "unknown-tab",
    /** The ref is not one the last snapshot of that tab handed out. */
    "unknown-ref",
    /** The tab is no longer on the site the action was approved for. */
    "wrong-site",
    /** A password box: never read, never typed into. */
    "password-field",
    /** The person pressed Stop, or switched Polar's browser use off. */
    "stopped",
    /** The page cannot be scripted (a browser page, a store, a PDF viewer). */
    "unscriptable",
    /** Anything else that went wrong in the browser. */
    "failed"
] as const;
export type BrowserRefusal = (typeof BROWSER_REFUSALS)[number];

const element = z.object({
    ref,
    role: z.string().max(40),
    name: z.string().max(200),
    /** A box's current value. A password box never carries one. */
    value: z.string().max(200).optional(),
    href: z.string().max(2048).optional(),
    password: z.boolean().optional()
});
export type BrowserElement = z.infer<typeof element>;

/** What the extension answers. */
export const browserResult = z.union([
    z.object({
        ok: z.literal(true),
        tab,
        url: z.string().max(4096),
        title: z.string().max(500),
        /** A read's text, as Markdown-like lines. */
        text: z
            .string()
            .max(BROWSER_TEXT_MOST + 200)
            .optional(),
        truncated: z.boolean().optional(),
        /** A snapshot's elements. */
        elements: z.array(element).max(BROWSER_ELEMENTS_MOST).optional()
    }),
    z.object({
        ok: z.literal(false),
        refusal: z.enum(BROWSER_REFUSALS),
        detail: z.string().max(500).optional()
    })
]);
export type BrowserResult = z.infer<typeof browserResult>;

/** One command as it travels: the id the answer is filed under. */
export const browserEnvelope = z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    command: browserCommand
});
export type BrowserEnvelope = z.infer<typeof browserEnvelope>;

/** One answer as it travels back. */
export const browserAnswer = z.object({
    id: browserEnvelope.shape.id,
    result: browserResult
});
export type BrowserAnswer = z.infer<typeof browserAnswer>;

/** Whether a command changes anything on the page, so it needs the card. */
export function browserCommandWrites(command: Pick<BrowserCommand, "kind">): boolean {
    return command.kind === "click" || command.kind === "type";
}

/** The site of an address as the grant and the card name it: the host,
 *  lowercased, with a port only when one was written. Null for anything that
 *  is not http(s). */
export function browserSiteOf(url: string): string | null {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
        return parsed.host.toLowerCase();
    } catch {
        return null;
    }
}

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

/** A tab Polar opened, by the number the browser gave it. */
export const browserTab = z.number().int().nonnegative();
/** An element, by the ref a snapshot handed out. */
export const browserRef = z.string().regex(/^e\d{1,6}$/, "A ref from the find action, like e12.");
/** The site an action is approved for, as the card names it: a bare host. */
export const browserSite = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+(:\d{1,5})?$/, "A site, like github.com.");
/** An address Polar may open: http or https only. */
export const browserAddress = z
    .string()
    .trim()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), "An http or https address.");
/** A CSS selector a read narrows to. */
export const browserSelector = z.string().trim().min(1).max(300);
/** Words a snapshot narrows to. */
export const browserQuery = z.string().trim().max(200);

/** Keys pressed in one call: "Enter", "Escape", "PageDown", "Control+a". */
export const browserKeys = z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9+ ]+$/, 'Keys like "Enter", "PageDown" or "Control+a".');
/** The grant the chat's card already asked for, so the extension's own
 *  question opens on the same answer. The extension still asks: the server can
 *  never grant itself a site. */
export const browserGrantHint = z.enum(["once", "always"]);

/** The tab an action is on: one Polar opened or adopted, or left out for the
 *  tab the person has in front. */
const onTab = { tab: browserTab.optional(), grant: browserGrantHint.optional() };
/** An action that changes a page names the site it was approved for. */
const acting = { ...onTab, site: browserSite };

/** What the dashboard asks the extension to do. */
export const browserCommand = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("open"), url: browserAddress, grant: browserGrantHint.optional() }),
    z.object({
        kind: z.literal("read"),
        ...onTab,
        site: browserSite.optional(),
        selector: browserSelector.optional()
    }),
    z.object({
        kind: z.literal("find"),
        ...onTab,
        site: browserSite.optional(),
        query: browserQuery.optional()
    }),
    z.object({ kind: z.literal("click"), ...acting, ref: browserRef }),
    z.object({
        kind: z.literal("type"),
        ...acting,
        ref: browserRef,
        text: z.string().max(BROWSER_TYPE_MOST),
        submit: z.boolean().optional()
    }),
    z.object({ kind: z.literal("key"), ...acting, keys: browserKeys }),
    z.object({
        kind: z.literal("scroll"),
        ...acting,
        /** Scrolls this element into view instead of by an amount. */
        ref: browserRef.optional(),
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        /** Screens to scroll, 1 by default. */
        amount: z.number().min(0.1).max(10).optional()
    }),
    z.object({ kind: z.literal("hover"), ...acting, ref: browserRef }),
    z.object({ kind: z.literal("select"), ...acting, ref: browserRef, value: z.string().max(200) }),
    z.object({ kind: z.literal("back"), ...acting }),
    z.object({ kind: z.literal("forward"), ...acting }),
    z.object({ kind: z.literal("reload"), ...acting }),
    z.object({ kind: z.literal("wait"), seconds: z.number().min(0.2).max(10) }),
    z.object({ kind: z.literal("close"), tab: browserTab }),
    /** Withdraws an "always" grant. Only ever narrows what Polar may do. */
    z.object({ kind: z.literal("forget"), site: browserSite })
]);
export type BrowserCommand = z.infer<typeof browserCommand>;

/** Why a command did not run, as a code the dashboard words for the model. */
export const BROWSER_REFUSALS = [
    /** The person said no to this site in the extension, or did not answer. */
    "site-denied",
    /** Polar may only touch tabs it opened or was shown, and this one is gone. */
    "unknown-tab",
    /** The ref is not one the last snapshot of that tab handed out. */
    "unknown-ref",
    /** The tab is no longer on the site the action was approved for. */
    "wrong-site",
    /** A password box: never read, never typed into. */
    "password-field",
    /** The person pressed Stop on the bar Polar shows in the tab. */
    "stopped",
    /** The page cannot be scripted (a browser page, a store, a PDF viewer). */
    "unscriptable",
    /** Anything else that went wrong in the browser. */
    "failed"
] as const;
export type BrowserRefusal = (typeof BROWSER_REFUSALS)[number];

const element = z.object({
    ref: browserRef,
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
        tab: browserTab,
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

/** Whether a command changes anything on the page. */
export function browserCommandWrites(command: Pick<BrowserCommand, "kind">): boolean {
    return ["click", "type", "key", "select"].includes(command.kind);
}

/** Words on an element or in a typed text that mean the action sends, pays,
 *  deletes or touches a secret - English and Spanish, the languages Polaris
 *  speaks. */
const RISKY =
    /(submit|send|post|publish|tweet|reply|buy|purchase|order|pay|payment|checkout|check out|card|cvv|iban|transfer|donate|subscribe|delete|remove|erase|destroy|cancel|unsubscribe|confirm|accept|sign out|log out|password|passcode|pin|enviar|env[ií]a|publicar|responder|comprar|compra|pedido|pagar|pago|tarjeta|transferir|transferencia|donar|suscribw*|borrar|elimina|eliminar|quitar|cancelar|confirmar|aceptar|cerrar sesi[oó]n|contrase[nñ]a)/i;

/**
 * Whether an action is one the person approves every time, whatever site they
 * allowed: it submits, sends, buys, deletes or touches a password or a card.
 * The rule Claude in Chrome applies to high-risk actions. Pure.
 */
export function browserHighRisk(command: BrowserCommand, element = ""): boolean {
    if (!browserCommandWrites(command)) return false;
    if (command.kind === "type" && command.submit) return true;
    if (command.kind === "key" && /enter/i.test(command.keys)) return true;
    if (RISKY.test(element)) return true;
    if (command.kind === "select") return RISKY.test(command.value);
    return false;
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

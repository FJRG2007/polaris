/**
 * The messages between a plugin's own view - a sandboxed frame on its page in
 * Settings, served by the desktop app from the installed package - and the page
 * holding it. The frame has no bridge of its own: it asks the page, the page
 * asks the app (`plugins.viewCall`), and the app judges the call like one from
 * the plugin's process. Everything the frame sends is read here before the page
 * acts on it.
 */

import { z } from "zod";

/** The scheme the desktop app serves plugin views from. */
/** Its name from before the rename: the one every desktop app serves. The newer apps serve `polaris-plugin` too. */
export const PLUGIN_VIEW_SCHEME = "polaris-addon";

/**
 * Where the view of an installed plugin loads from. The app serves the folder
 * that holds the view's entry as the address's root, so the entry is its file
 * name there and what it loads by a relative path stays inside that folder.
 */
export function pluginViewUrl(id: string, view: string): string {
    return `${PLUGIN_VIEW_SCHEME}://${id}/${encodeURIComponent(view.split("/").pop() ?? view)}`;
}

/** The design tokens handed to a view, so it draws in the page's own colours. */
export const PLUGIN_VIEW_TOKENS = [
    "--background",
    "--foreground",
    "--card",
    "--muted",
    "--muted-foreground",
    "--border",
    "--border-strong",
    "--primary",
    "--primary-foreground",
    "--accent",
    "--accent-foreground",
    "--ring",
    "--danger",
    "--success",
    "--warning",
    "--radius",
    "--font-sans",
    "--font-mono"
] as const;

/** The most a view may ask the frame to grow to, and the least it is drawn at. */
export const PLUGIN_VIEW_HEIGHT = { min: 120, max: 1600 } as const;

const viewMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready") }),
    z.object({ type: z.literal("resize"), height: z.number().finite() }),
    z.object({
        type: z.literal("call"),
        id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        method: z.string().max(64),
        params: z.unknown().optional()
    })
]);

export type PluginViewMessage = z.infer<typeof viewMessageSchema>;

/** A message from the view, or null for anything else. */
export function readPluginViewMessage(value: unknown): PluginViewMessage | null {
    const parsed = viewMessageSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

const replySchema = z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.enum(["permission", "unknown-method", "bad-params", "failed"]) })
]);

export type PluginViewReply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: "permission" | "unknown-method" | "bad-params" | "failed" };

/** What the app answered for a view's call; anything unreadable is a failure. */
export function readPluginViewReply(value: unknown): PluginViewReply {
    const parsed = replySchema.safeParse(value);
    return parsed.success ? (parsed.data as PluginViewReply) : { ok: false, error: "failed" };
}

/** The height a view asked for, held between the bounds. */
export function pluginViewHeight(asked: number): number {
    return Math.round(Math.min(PLUGIN_VIEW_HEIGHT.max, Math.max(PLUGIN_VIEW_HEIGHT.min, asked)));
}

/** The page's tokens as they are drawn now, for the view. */
export function pluginViewTokens(style: Pick<CSSStyleDeclaration, "getPropertyValue">): Record<string, string> {
    const tokens: Record<string, string> = {};
    for (const name of PLUGIN_VIEW_TOKENS) {
        const value = style.getPropertyValue(name).trim();
        if (value) tokens[name] = value.slice(0, 400);
    }
    return tokens;
}

/** What a view is told about the page: sent when it is ready, and again whenever any of it changes. */
export type PluginViewHello = { readonly type: "hello"; readonly locale: string; readonly theme: "light" | "dark"; readonly tokens: Record<string, string> };

/** The page as a view should draw it now. */
export function pluginViewHello(locale: string, dark: boolean, style: Pick<CSSStyleDeclaration, "getPropertyValue">): PluginViewHello {
    return { type: "hello", locale, theme: dark ? "dark" : "light", tokens: pluginViewTokens(style) };
}

/**
 * Call `onChange` whenever the page's look may have moved: the root's class,
 * `data-theme` or inline style (theme, accent, text size), or the system
 * scheme under a page set to follow it. It reports possible changes; the
 * caller compares what it would send with what it sent last.
 */
export function watchPluginViewLook(onChange: () => void): () => void {
    if (typeof document === "undefined") return () => undefined;
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => onChange());
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    const scheme = typeof matchMedia === "undefined" ? null : matchMedia("(prefers-color-scheme: dark)");
    scheme?.addEventListener("change", onChange);
    return () => {
        observer?.disconnect();
        scheme?.removeEventListener("change", onChange);
    };
}

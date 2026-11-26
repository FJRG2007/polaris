/**
 * A plugin's own view: the page it ships for what declared settings cannot
 * draw (the Stream 100's knob map, a display preview), shown in a sandboxed
 * frame on its page in Settings.
 *
 * The frame loads from `polaris-addon://<id>/<file>` (or `polaris-plugin://`), served only out of the
 * folder that holds the view's entry inside the installed package, with a
 * policy that lets it load nothing from anywhere else and reach no network. It
 * has no bridge of its own: it talks to the page holding it through
 * `postMessage`, and the page asks the app through `plugins.viewCall`, which is
 * judged here like a call from the plugin's process, plus `settings.set`, which
 * only the view may use. Pure of Electron, for the tests.
 */

import { z } from "zod";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { judgeCall, type PluginMethod } from "@/shared/plugin-protocol";
import type { PluginPermission } from "@polaris/core/device-plugins";

/**
 * The scheme views are addressed with. It keeps the name from before the
 * rename, because hosts from before it allow only `polaris-addon:` frames; the
 * new name is served too (`VIEW_SCHEMES`), so the address can move to it once
 * every supported host allows it. Removable once no supported desktop app or host predates the rename (desktop 0.1.124).
 */
export const VIEW_SCHEME = "polaris-addon";
/** Every scheme a view is served under: the new name, and the one hosts before the rename frame. */
export const VIEW_SCHEMES = ["polaris-plugin", VIEW_SCHEME] as const;

/** Nothing from anywhere but its own files; no network, no frames, no forms. */
export const VIEW_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";

const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".woff2": "font/woff2"
};

/** The type a view file is served as, or null for one it may not serve. */
export function viewContentType(path: string): string | null {
    return TYPES[extname(path).toLowerCase()] ?? null;
}

/** Which plugin and which of its files a view address asks for, or null for one that is not a view address. */
export function readViewUrl(url: string): { id: string; path: string } | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (!VIEW_SCHEMES.some((scheme) => parsed.protocol === `${scheme}:`) || !/^[a-z][a-z0-9-]{1,47}$/.test(parsed.hostname)) return null;
    let path: string;
    try {
        path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    } catch {
        return null;
    }
    return path ? { id: parsed.hostname, path } : null;
}

/**
 * The file on disk for `path` in an installed plugin whose view is `view`
 * (relative to the package), or null: only files in the folder that holds the
 * view, of a type it may serve, never a path that leaves that folder.
 */
export function resolveViewFile(packageRoot: string, view: string, path: string): string | null {
    if (!viewContentType(path) || path.includes("\0") || isAbsolute(path)) return null;
    const folder = resolve(packageRoot, dirname(view));
    const file = resolve(folder, path);
    const inside = relative(folder, file);
    if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).includes("..")) return null;
    return join(folder, inside);
}

const setSchema = z.object({ key: z.string().max(64), value: z.union([z.boolean(), z.string().max(200), z.number(), z.null()]) });

export type ViewVerdict =
    | { readonly ok: true; readonly kind: "set"; readonly key: string; readonly value: boolean | string | number | null; }
    | { readonly ok: true; readonly kind: "driver"; readonly action: "look"; }
    | { readonly ok: true; readonly kind: "call"; readonly method: PluginMethod; readonly params: unknown; }
    | { readonly ok: false; readonly error: "permission" | "unknown-method" | "bad-params"; };

/**
 * Whether a call from a plugin's view goes through: `settings.set`, a look
 * at the device's own driver (`driver.look`; its setup is a declared setting,
 * so it changes only through `settings.set` or the list around the view), or
 * what its process may call.
 */
export function judgeViewCall(granted: readonly PluginPermission[], method: string, params: unknown): ViewVerdict {
    if (method === "settings.set") {
        const parsed = setSchema.safeParse(params);
        return parsed.success ? { ok: true, kind: "set", key: parsed.data.key, value: parsed.data.value } : { ok: false, error: "bad-params" };
    }
    if (method === "driver.look") return { ok: true, kind: "driver", action: "look" };
    const verdict = judgeCall(granted, method, params);
    return verdict.ok ? { ok: true, kind: "call", method: verdict.method, params: verdict.params } : verdict;
}

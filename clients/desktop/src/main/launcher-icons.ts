/**
 * Where each listed program's picture comes from. Every source the launcher
 * lists has its own place for one, and the row is drawn from the first that
 * exists:
 *
 * - a shortcut (`.lnk`): the icon it names (`IconLocation`), else its target.
 *   Never the `.lnk` itself: Chromium's `getFileIcon` takes the picture of
 *   anything that is not an `.exe`, `.dll` or `.ico` by its extension, so
 *   every shortcut would get the same generic one;
 * - an Internet shortcut (`.url`, how Steam and Epic put games in the Start
 *   menu): its `IconFile`;
 * - a Store or Xbox app: the logo its `AppxManifest.xml` names, in the size
 *   Windows itself would draw it (`targetsize-*`, `scale-*` variants);
 * - a Steam game: the `.ico` its uninstall entry names (Steam's own
 *   `steam\games\<hash>.ico`, what its desktop shortcuts use), else the
 *   library cache's picture in either layout - `<id>_icon.jpg` flat in
 *   `librarycache`, or a hashed `.jpg` in `librarycache\<id>\`;
 * - a store game with no picture of its own: its executable's icon.
 *
 * What none of these give is drawn with the row kind's generic glyph, never
 * left blank. Everything here is pure; the readers that feed it live with
 * each source.
 */

import { win32 } from "node:path";
import { registryPath } from "./launcher-programs";

const { basename, dirname, join } = win32;

/** The files a picture can be read from: images, and programs' own icons. */
const ICON_FILE = /\.(exe|dll|ico|png|jpe?g)$/i;
/** Pictures read directly rather than asked of the shell. */
export const PICTURE_FILE = /\.(ico|png|jpe?g)$/i;
/** Executables that are never the game itself. */
const NOT_THE_GAME = /(unins|setup|install|crash|report|redist|vc_?redist|dxsetup|directx|helper|updater|launcherpatcher|cleanup|benchmark|eac|easyanticheat|battleye|be_service|unitycrashhandler|ue4prereq)/i;

/** A path a shortcut, registry value or `.url` names for a picture, expanded; null when it is not one. */
export function iconFile(value: string | undefined, env: NodeJS.ProcessEnv): string | null {
    const path = registryPath(value, env);
    return path && ICON_FILE.test(path) ? path : null;
}

/** What a `.lnk` is drawn from: the icon it names, else its target when that is a program. */
export function shortcutIcon(link: { readonly icon?: string; readonly target?: string; }, env: NodeJS.ProcessEnv): string | null {
    return iconFile(link.icon, env) ?? (link.target && /\.exe$/i.test(link.target) ? iconFile(link.target, env) : null);
}

/** The `IconFile` an Internet shortcut names (`[InternetShortcut]` section). */
export function urlShortcutIcon(text: string, env: NodeJS.ProcessEnv): string | null {
    const value = /^\s*IconFile\s*=\s*(\S[^\r\n]*)$/im.exec(text.slice(0, 64 * 1024))?.[1]?.trim();
    return iconFile(value, env);
}

/** The files a row's picture is tried from, best first. A `.lnk` or `.url` is never one (see the top of this file). */
export function iconCandidates(app: { readonly path: string; readonly icon?: string; readonly target?: string; }, platform: NodeJS.Platform): string[] {
    const out: string[] = [];
    if (app.icon) out.push(app.icon);
    if (app.target && /\.exe$/i.test(app.target)) out.push(app.target);
    if (platform === "darwin" ? app.path.endsWith(".app") : /\.exe$/i.test(app.path)) out.push(app.path);
    return [...new Set(out)];
}

/** The attribute `name` on the first tag in `text`, unescaped. */
function attribute(tag: string, name: string): string | undefined {
    const value = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1];
    return value?.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * The logo a package manifest names for one of its apps, relative to the
 * package folder: the app's `VisualElements` `Square44x44Logo` (what Start and
 * the taskbar draw), else its `Square150x150Logo`, else the package's own
 * `Properties/Logo`. Manifests are machine-written XML in one fixed schema, so
 * the tags are read as written rather than through a general XML parser,
 * which the desktop app does not carry. A resource reference (`ms-resource:`)
 * is not a file and is skipped.
 */
export function manifestLogo(manifest: string, appId: string): string | null {
    const text = manifest.slice(0, 1024 * 1024);
    const file = (value: string | undefined) => (value && !/^ms-(resource|appx):/i.test(value) && !/\.\.|^[\\/]|:/.test(value) ? value.replace(/\//g, "\\") : null);
    const apps = text.matchAll(/<(?:\w+:)?Application\b[^>]*>/gi);
    for (const found of apps) {
        if (attribute(found[0], "Id") !== appId) continue;
        const from = found.index ?? 0;
        const close = /<\/(?:\w+:)?Application>/i.exec(text.slice(from));
        const body = text.slice(from, close ? from + close.index : undefined);
        const visual = /<(?:\w+:)?VisualElements\b[^>]*>/i.exec(body)?.[0] ?? "";
        const logo = file(attribute(visual, "Square44x44Logo")) ?? file(attribute(visual, "Square150x150Logo"));
        if (logo) return logo;
        break;
    }
    return file(/<(?:\w+:)?Properties\b[\s\S]*?<(?:\w+:)?Logo>([^<]+)<\/(?:\w+:)?Logo>/i.exec(text)?.[1]?.trim());
}

/**
 * The file on disk for a manifest's logo. A package rarely ships the name the
 * manifest says: it ships qualified variants (`Logo.targetsize-32.png`,
 * `Logo.scale-200.png`, `Logo.targetsize-32_altform-unplated.png`) that
 * Windows picks from. This picks the one Windows would draw at a small size on
 * a dark surface: an unplated target size nearest 32 px at or above it, then
 * any target size, then the plainest scale, never a high-contrast variant.
 */
export function pickAsset(logo: string, names: readonly string[]): string | null {
    const file = basename(logo);
    const dot = file.lastIndexOf(".");
    const stem = (dot > 0 ? file.slice(0, dot) : file).toLowerCase();
    const ext = (dot > 0 ? file.slice(dot) : ".png").toLowerCase();
    let best: { name: string; score: number; } | null = null;
    for (const name of names) {
        const lower = name.toLowerCase();
        if (lower === file.toLowerCase()) return name;
        if (!lower.startsWith(`${stem}.`) || !lower.endsWith(ext)) continue;
        const qualifiers = lower.slice(stem.length + 1, lower.length - ext.length);
        if (/contrast-|altform-lightunplated/.test(qualifiers)) continue;
        const size = Number(/targetsize-(\d+)/.exec(qualifiers)?.[1]);
        const scale = Number(/scale-(\d+)/.exec(qualifiers)?.[1]);
        let score: number;
        if (Number.isFinite(size) && size > 0) score = 1000 - (size >= 32 ? size - 32 : 500 + (32 - size)) + (/altform-unplated/.test(qualifiers) ? 50 : 0);
        else if (Number.isFinite(scale) && scale > 0) score = 500 - Math.abs(scale - 100) / 10;
        else score = 100;
        if (!best || score > best.score) best = { name, score };
    }
    return best?.name ?? null;
}

/** The folder the manifest's logo sits in, under the package's own folder. */
export function assetFolder(location: string, logo: string): string {
    return dirname(join(location, logo));
}

/**
 * The icon in a Steam game's own library cache folder (`librarycache\<id>\`,
 * the layout newer clients write): the file named by the icon's content hash,
 * 40 hex digits. The other files there are named for what they are
 * (`header.jpg`, `library_600x900.jpg`, `logo.png`) and are banners, not icons.
 */
export function steamFolderIcon(names: readonly string[]): string | null {
    return names.find((name) => /^[0-9a-f]{40}\.(jpg|png|ico)$/i.test(name)) ?? null;
}

/** The app id an uninstall key for a Steam game ends in (`...\Uninstall\Steam App 730`). */
export function steamUninstallId(key: string): string | null {
    return /\\Steam App (\d{1,10})$/i.exec(key)?.[1] ?? null;
}

/**
 * The executable in a game's folder most likely to be the game, for its icon:
 * the one whose name is closest to the game's, never an uninstaller, a setup,
 * a crash reporter or an anti-cheat service. Null when none is.
 */
export function gameExe(label: string, exes: readonly string[]): string | null {
    const words = (text: string) => text.toLowerCase().replace(/\.exe$/, "").split(/[^a-z0-9]+/).filter(Boolean);
    const wanted = new Set(words(label));
    const squashed = words(label).join("");
    let best: { exe: string; score: number; } | null = null;
    for (const exe of exes) {
        const name = basename(exe);
        if (!/\.exe$/i.test(name) || NOT_THE_GAME.test(name)) continue;
        const own = words(name);
        const shared = own.filter((word) => wanted.has(word)).length;
        const joined = own.join("");
        const score = shared * 10 + (joined && squashed.includes(joined) ? 5 : 0) + (joined === squashed ? 20 : 0) - (/(launcher|x86|32)/i.test(name) ? 1 : 0);
        if (!best || score > best.score) best = { exe, score };
    }
    return best?.exe ?? null;
}

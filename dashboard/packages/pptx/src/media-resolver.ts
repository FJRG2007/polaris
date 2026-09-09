/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

/**
 * Turning a picture inside a .pptx into something a browser will draw.
 *
 * The renderer is handed plain data - it never sees the package - so every image
 * a slide references has to arrive as a URL. This is what makes them, reading
 * the bytes out of the archive and answering with a `data:` URL the canvas can
 * load directly.
 *
 * Three corrections happen on the way out, and each of them is a picture that
 * renders wrongly without it:
 *
 * - **The declared type is not trusted.** Converters mislabel media routinely - a
 *   PNG preview stored as `.emf` is common - so the container is sniffed from
 *   its first bytes and the extension is only the fallback.
 * - **A themed SVG is retinted.** Office stores those with class names
 *   (`MsftOfcThm_accent1_Fill`) that resolve against the deck's colour scheme,
 *   which nothing outside Office knows. Left alone they draw in whatever colour
 *   the file happens to carry rather than the deck's.
 * - **A JPEG's EXIF rotation is neutralized.** PowerPoint ignores it and draws
 *   the raw pixel grid; a browser applies it. A photo that carries both a
 *   rotated grid and the flag, inside a shape that is itself rotated, ends up
 *   ninety degrees out.
 *
 * The archive keeps the original bytes throughout: none of this is written back,
 * so a deck that is opened and saved is unchanged.
 *
 * **TIFF is not decoded.** Upstream transcodes it to PNG in its main process
 * with two image libraries; no browser can decode TIFF, so such a picture is
 * blank here. It is rare inside a .pptx and it was blank before this existed
 * too - said plainly rather than left to be discovered.
 */

import type { OpenedPptx } from "./index";
import { displayMime } from "./media-mime";
import { neutralizeJpegOrientation } from "./jpeg-orientation";
import { parseTheme, parseClrMap, resolveSchemeColor } from "./theme";

/** The scheme slot each `MsftOfcThm_` class name refers to. */
const SVG_THEME_SLOTS: Record<string, string> = {
    background1: "bg1",
    text1: "tx1",
    background2: "bg2",
    text2: "tx2",
    accent1: "accent1",
    accent2: "accent2",
    accent3: "accent3",
    accent4: "accent4",
    accent5: "accent5",
    accent6: "accent6",
    hyperlink: "hlink",
    followedhyperlink: "folHlink"
};

/** Base64 for a byte array, on a server or in a browser. `Buffer` is Node's and
 *  this has to work in both, since the same deck is rendered in either. */
function base64(bytes: Uint8Array): string {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/**
 * Resolve an Office-themed SVG's colours against the deck's own scheme.
 *
 * Returns the SVG untouched when anything is missing - a deck with no theme is a
 * deck whose SVG was already drawn in real colours.
 */
export function retintThemedSvg(svg: string, opened: OpenedPptx, slidePath?: string): string {
    const path = slidePath ?? opened.deck.slides[0]?.path;
    if (!path) return svg;
    let theme;
    try {
        const chain = opened.archive.resolveSlideChain(path);
        const themeXml = chain.themePath ? opened.archive.readText(chain.themePath) : null;
        if (!themeXml) return svg;
        theme = parseTheme(themeXml);
        theme.clrMap = parseClrMap(
            (chain.masterPath ? opened.archive.readText(chain.masterPath) : null) ?? undefined,
            (chain.layoutPath ? opened.archive.readText(chain.layoutPath) : null) ?? undefined,
            opened.archive.readText(path) ?? undefined
        );
    } catch {
        return svg;
    }
    return svg.replace(
        /\.MsftOfcThm_(\w+?)_(Fill|Stroke)\w*\s*\{[^}]*\}/g,
        (rule, slot: string, kind: string) => {
            const scheme = SVG_THEME_SLOTS[slot.toLowerCase()];
            const color = scheme ? resolveSchemeColor(scheme, theme) : undefined;
            if (!color) return rule;
            const property = kind === "Stroke" ? "stroke" : "fill";
            return rule.replace(new RegExp(`${property}\\s*:\\s*[^;}]+`, "g"), `${property}:${color}`);
        }
    );
}

/**
 * A resolver from a slide's media reference to a URL the renderer can draw.
 *
 * Answers `undefined` for a part that is not in the package, which is a picture
 * the deck references and does not carry - the renderer draws its frame and
 * nothing in it, rather than failing the slide.
 *
 * Cached per deck: a template's logo is referenced by every page, and decoding
 * it once per reference is the difference between a deck opening and a deck
 * appearing to hang.
 */
export function makeMediaResolver(
    opened: OpenedPptx,
    slidePath?: string
): (mediaRef: string) => string | undefined {
    const cache = new Map<string, string | undefined>();
    return (mediaRef: string): string | undefined => {
        if (cache.has(mediaRef)) return cache.get(mediaRef);
        const bytes = opened.archive.readBytes(mediaRef);
        let url: string | undefined;
        if (bytes) {
            const mime = displayMime(mediaRef, bytes);
            if (mime === "image/tiff") {
                url = undefined;
            } else if (mime === "image/svg+xml") {
                let text = new TextDecoder().decode(bytes);
                if (text.includes("MsftOfcThm_")) text = retintThemedSvg(text, opened, slidePath);
                url = `data:${mime};base64,${base64(new TextEncoder().encode(text))}`;
            } else {
                const served = mime === "image/jpeg" ? neutralizeJpegOrientation(bytes) : bytes;
                url = `data:${mime};base64,${base64(served)}`;
            }
        }
        cache.set(mediaRef, url);
        return url;
    };
}

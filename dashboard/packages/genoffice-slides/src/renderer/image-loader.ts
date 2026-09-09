/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

/**
 * Collecting a deck's image urls, and loading them.
 *
 * Incremental image loading: each decoded image is surfaced in small batches
 * instead of waiting for the whole deck (385 pictures used to render nothing
 * until the last one settled). Loaded/in-flight urls are tracked across calls
 * so re-collecting urls after an edit never reloads or discards progress.
 *
 * The walk that finds those urls lives here too, so every surface that draws a
 * RenderSlide collects the same set.
 */
import { metafileToDataUrl } from "@polaris/docx/metafile";
import type { RenderFill, RenderNode, RenderSlide } from "@polaris/pptx-render";

/**
 * Every image URL a deck draws, in one place.
 *
 * A url the renderer reads and this walk does not collect is an image that is
 * never loaded and so silently draws nothing — which is why this is one function
 * rather than a copy per caller: the two copies that existed both missed a
 * shape's fillOverlay and a chart's plot-area fill, and neither had any way of
 * finding out. Every site here is a `fillToKonva` or an `images.get` in
 * NodeBody, ChartBody or SlideThumb; adding one there means adding it here.
 */
export function collectImageUrls(slides: readonly RenderSlide[]): Set<string> {
    const urls = new Set<string>();
    const fromFill = (fill: RenderFill | undefined) => {
        if (fill && fill.kind === "image" && fill.dataUrl) urls.add(fill.dataUrl);
    };
    const walk = (nodes: readonly RenderNode[]) => {
        for (const n of nodes) {
            switch (n.type) {
                case "picture":
                    if (n.dataUrl) urls.add(n.dataUrl);
                    fromFill(n.fill);
                    break;
                case "shape":
                case "text":
                    fromFill(n.fill);
                    fromFill(n.fillOverlay);
                    break;
                case "chart":
                    fromFill(n.bgFill);
                    fromFill(n.plotRect?.fill);
                    break;
                case "table":
                    fromFill(n.bgFill);
                    for (const c of n.cells) fromFill(c.fill);
                    break;
                case "group":
                    walk(n.children);
                    break;
            }
        }
    };
    for (const s of slides) {
        fromFill(s.background);
        walk(s.nodes);
    }
    return urls;
}

export type ApplyImages = (entries: ReadonlyArray<readonly [string, HTMLImageElement]>) => void;

/** EMF/WMF data URLs: browsers cannot decode metafiles — rasterize to PNG first (keyed by the original url). */
const METAFILE_RE = /^data:(image\/x-(?:emf|wmf)|image\/(?:emf|wmf));base64,/;

/**
 * Metafile text draws through canvas fonts, so the Office-private FontFaces (DFonts/cloud/
 * embedded, registered by doc-fonts.ts after the deck settles) must be in place first — an
 * EMF rasterized before that keeps its fallback face forever (Excel OLE previews in
 * Meiryo UI came out in the browser's default sans). `false` = a sync is in flight.
 */
function waitForDocFonts(timeoutMs = 4000): Promise<void> {
    if (typeof window === "undefined" || window.__genofficeDocFontsSynced !== false)
        return Promise.resolve();
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            if (window.__genofficeDocFontsSynced !== false || Date.now() - started >= timeoutMs)
                resolve();
            else setTimeout(tick, 50);
        };
        setTimeout(tick, 50);
    });
}

async function rasterizeMetafile(url: string): Promise<string | null> {
    const m = METAFILE_RE.exec(url);
    if (!m) return null;
    await waitForDocFonts();
    const b64 = url.slice(url.indexOf(",") + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime = m[1]!.includes("emf") ? "image/x-emf" : "image/x-wmf";
    return metafileToDataUrl(bytes, mime);
}

export function createImageLoader(apply: ApplyImages, batchSize = 16, delayMs = 100) {
    const loaded = new Map<string, HTMLImageElement>();
    const loading = new Set<string>();
    const buf = new Map<string, HTMLImageElement>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (disposed || buf.size === 0) return;
        const entries = [...buf];
        buf.clear();
        apply(entries);
    };

    return {
        load(urls: Iterable<string>) {
            for (const u of urls) {
                if (loaded.has(u) || loading.has(u)) continue;
                loading.add(u);
                const img = new Image();
                const done = (ok: boolean) => {
                    loading.delete(u);
                    if (ok) {
                        loaded.set(u, img);
                        if (!disposed) buf.set(u, img);
                    }
                    if (buf.size >= batchSize || loading.size === 0) flush();
                    else if (!timer && buf.size > 0) timer = setTimeout(flush, delayMs);
                };
                img.onload = () => done(true);
                img.onerror = () => done(false);
                if (METAFILE_RE.test(u)) {
                    void rasterizeMetafile(u)
                        .then((png) => {
                            if (png) img.src = png;
                            else done(false);
                        })
                        .catch(() => done(false));
                } else {
                    img.src = u;
                }
            }
        },
        // Only guards setState after unmount; in-flight loads keep filling `loaded`
        dispose() {
            disposed = true;
            if (timer) clearTimeout(timer);
        }
    };
}

"use client";

/**
 * A PowerPoint file, drawn by the engine that understands one.
 *
 * What was here before was a parser written for this viewer: it read a slide's
 * shapes and paragraphs and laid them out with absolutely positioned elements.
 * Seven hundred lines, and an approximation - no theme, no layout or master
 * inheritance, no gradient or picture fills, no charts, no tables, no text
 * measurement. A deck built from a template, which is every deck anybody is
 * handed, drew in the wrong colours at the wrong sizes, and nothing on screen
 * said so.
 *
 * The real engine was already in the repository, unused: `@polaris/pptx` parses
 * the package the way PowerPoint does and `@polaris/pptx-render` resolves a page
 * into `RenderSlide` - plain data saying exactly what to draw. Those need Node,
 * so they run on the server; this sends the bytes it already fetched and is
 * handed the pages back.
 *
 * The drawing is GenOffice's own (Apache-2.0, see NOTICE) - the same component
 * its slides editor uses for thumbnails, which is why a page here and a page
 * there are identical. It draws to a canvas and needs no bridge of any kind, so
 * it is eighty kilobytes rather than the three megabytes of the whole editor.
 *
 * Read-only. Writing a .pptx back is a separate piece of work and this claims
 * none of it.
 */

import dynamic from "next/dynamic";
import { Loading, ViewerError } from "./status";
import { Button, cn, ScrollRow } from "@polaris/ui";
import type { RenderSlide } from "@polaris/pptx-render";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Canvas drawing, so it cannot render on the server and must not be in the
 *  bundle of a screen that never opens a presentation. */
const SlideThumb = dynamic(
    async () => (await import("@polaris/genoffice-slides/slide")).SlideThumb,
    { ssr: false, loading: () => <Loading /> }
);

/** The width the server builds pages for. The component scales whatever it is
 *  given to the width it is drawn at, so this is a resolution rather than a
 *  layout: one build serves every size the dialog takes. */
const BUILD_WIDTH = 1280;

/** What a reader is told when nothing better is known - the bytes never arrived,
 *  or whatever answered was not this route. */
const UNREADABLE = "This presentation could not be rendered.";

/** The renderer's own image loader, as the dynamic import below hands it back.
 *  A type query, so naming it here pulls nothing into this bundle. */
type ImageLoader = ReturnType<typeof import("@polaris/genoffice-slides/images").createImageLoader>;

/**
 * Why a build was refused, in the words the route chose.
 *
 * The route separates a presentation that is too large from one that could not
 * be read from a share that is no longer open, and it is the only thing here
 * that knows which - collapsing all three into one sentence makes an oversized
 * deck read as a broken viewer. Only a sentence it actually wrote is shown:
 * anything else answering on that path is not addressed to a reader.
 */
async function refusal(answer: Response): Promise<string> {
    try {
        const body = (await answer.json()) as { error?: unknown };
        if (typeof body.error === "string" && body.error.trim() && body.error.length <= 200)
            return body.error;
    } catch {
        // Not JSON, so not this route's answer.
    }
    return UNREADABLE;
}

/**
 * Every image any page refers to, loaded once.
 *
 * The pages arrive with their pictures as `data:` URLs and the canvas needs
 * decoded images, keyed by that same URL. Both halves are the renderer's own -
 * the same walk that finds the URLs and the same loader that decodes them, so a
 * picture drawn in GenOffice's editor is a picture drawn here. That loader is
 * what rasterizes an EMF or a WMF, which no browser decodes and which a plain
 * `Image` would leave as an empty frame, and it is what hands the decoded ones
 * over in batches rather than leaving a deck blank until the last one settles.
 *
 * Loaded across the whole deck rather than per page: a template's logo is on
 * every page, and the alternative is decoding it again on each one.
 */
function useDeckImages(slides: readonly RenderSlide[] | null): Map<string, HTMLImageElement> {
    const [images, setImages] = useState<Map<string, HTMLImageElement>>(new Map());

    useEffect(() => {
        // A new deck starts with nothing decoded. Without this a deck with no
        // pictures shows the previous one's, since nothing would replace them.
        setImages(new Map());
        let loader: ImageLoader | null = null;
        let done = false;
        void (async () => {
            // Imported here rather than at the top: it carries a metafile
            // rasterizer, and this module is in the bundle of every file Drive
            // previews, not only a presentation.
            const engine = await import("@polaris/genoffice-slides/images");
            if (done) return;
            loader = engine.createImageLoader((entries) => {
                setImages((current) => {
                    const next = new Map(current);
                    for (const [url, image] of entries) next.set(url, image);
                    return next;
                });
            });
            loader.load(engine.collectImageUrls(slides ?? []));
        })();
        return () => {
            done = true;
            loader?.dispose();
        };
    }, [slides]);

    return images;
}

export function PptxView({ src, token }: { src: string; token?: string }) {
    const [slides, setSlides] = useState<readonly RenderSlide[] | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [index, setIndex] = useState(0);
    const [width, setWidth] = useState(0);
    const frameRef = useRef<HTMLDivElement | null>(null);
    const images = useDeckImages(slides);

    useEffect(() => {
        let alive = true;
        setSlides(null);
        setFailed(null);
        setIndex(0);
        void (async () => {
            // Held aside rather than thrown, so what a reader sees is only ever a
            // sentence written for them: a dropped connection throws too, and its
            // message is about sockets.
            let refused = UNREADABLE;
            try {
                const file = await fetch(src);
                if (!file.ok) throw new Error("read failed");
                const query = new URLSearchParams({ w: String(BUILD_WIDTH) });
                if (token) query.set("t", token);
                const built = await fetch(`/api/drive/slides?${query.toString()}`, {
                    method: "POST",
                    body: await file.arrayBuffer()
                });
                if (!built.ok) {
                    refused = await refusal(built);
                    throw new Error("render failed");
                }
                const answer = (await built.json()) as { slides?: RenderSlide[] };
                if (alive) setSlides(answer.slides ?? []);
            } catch {
                if (alive) setFailed(refused);
            }
        })();
        return () => {
            alive = false;
        };
    }, [src, token]);

    // One measurement drives the deck: the pages are built once and drawn at
    // whatever width the dialog settles on.
    useEffect(() => {
        const frame = frameRef.current;
        if (!frame) return;
        const observer = new ResizeObserver(([entry]) => {
            const measured = entry?.contentRect.width ?? 0;
            if (measured > 0) setWidth(measured);
        });
        observer.observe(frame);
        return () => observer.disconnect();
    }, [slides]);

    useEffect(() => {
        if (!slides || slides.length === 0) return;
        const last = slides.length - 1;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            const step = event.key === "ArrowRight" ? 1 : -1;
            setIndex((current) => Math.min(Math.max(current + step, 0), last));
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [slides]);

    if (failed) return <ViewerError>{failed}</ViewerError>;
    if (!slides) return <Loading />;
    if (slides.length === 0) return <ViewerError>This presentation has no slides.</ViewerError>;

    const slide = slides[Math.min(index, slides.length - 1)]!;

    return (
        <div className="flex min-h-0 flex-col gap-3">
            <div ref={frameRef} className="w-full overflow-hidden rounded-lg border border-border">
                {width > 0 ? <SlideThumb slide={slide} images={images} width={width} /> : null}
            </div>

            {slides.length > 1 ? (
                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Previous slide"
                        disabled={index === 0}
                        onClick={() => setIndex((current) => Math.max(current - 1, 0))}
                    >
                        <ChevronLeft className="size-4 shrink-0" aria-hidden />
                    </Button>
                    <ScrollRow className="flex-1">
                        {slides.map((_slide, at) => (
                            <button
                                key={at}
                                type="button"
                                onClick={() => setIndex(at)}
                                aria-label={`Slide ${at + 1}`}
                                aria-current={at === index}
                                className={cn(
                                    "shrink-0 rounded border px-2 py-1 text-xs",
                                    at === index
                                        ? "border-primary text-foreground"
                                        : "border-border text-foreground-subtle"
                                )}
                            >
                                {at + 1}
                            </button>
                        ))}
                    </ScrollRow>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Next slide"
                        disabled={index >= slides.length - 1}
                        onClick={() =>
                            setIndex((current) => Math.min(current + 1, slides.length - 1))
                        }
                    >
                        <ChevronRight className="size-4 shrink-0" aria-hidden />
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

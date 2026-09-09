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
import { useEffect, useMemo, useRef, useState } from "react";

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

/**
 * Every image any page refers to, loaded once.
 *
 * The pages arrive with their pictures as `data:` URLs and the canvas needs
 * decoded images, keyed by that same URL. Loaded across the whole deck rather
 * than per page: a template's logo is on every page, and the alternative is
 * decoding it again on each one.
 */
function useDeckImages(slides: readonly RenderSlide[] | null): Map<string, HTMLImageElement> {
    const [images, setImages] = useState<Map<string, HTMLImageElement>>(new Map());

    const wanted = useMemo(() => {
        const urls = new Set<string>();
        const fromFill = (fill: unknown): void => {
            const image = fill as { kind?: string; dataUrl?: string } | undefined;
            if (image?.kind === "image" && image.dataUrl) urls.add(image.dataUrl);
        };
        const walk = (nodes: readonly unknown[]): void => {
            for (const node of nodes) {
                const one = node as {
                    type?: string;
                    dataUrl?: string;
                    fill?: unknown;
                    bgFill?: unknown;
                    children?: unknown[];
                    cells?: { fill?: unknown }[];
                };
                if (one.type === "picture" && one.dataUrl) urls.add(one.dataUrl);
                fromFill(one.fill);
                fromFill(one.bgFill);
                if (one.children) walk(one.children);
                for (const cell of one.cells ?? []) fromFill(cell.fill);
            }
        };
        for (const slide of slides ?? []) {
            fromFill(slide.background);
            walk(slide.nodes);
        }
        return [...urls];
    }, [slides]);

    useEffect(() => {
        if (wanted.length === 0) return;
        let alive = true;
        const loaded = new Map<string, HTMLImageElement>();
        let waiting = wanted.length;
        const settle = (): void => {
            waiting -= 1;
            if (waiting === 0 && alive) setImages(new Map(loaded));
        };
        for (const url of wanted) {
            const image = new Image();
            image.onload = () => {
                loaded.set(url, image);
                settle();
            };
            // A picture the deck names and does not carry, or one in a format
            // this browser cannot decode. The page draws without it rather than
            // waiting for it forever.
            image.onerror = settle;
            image.src = url;
        }
        return () => {
            alive = false;
        };
    }, [wanted]);

    return images;
}

export function PptxView({ src, token }: { src: string; token?: string }) {
    const [slides, setSlides] = useState<readonly RenderSlide[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [index, setIndex] = useState(0);
    const [width, setWidth] = useState(0);
    const frameRef = useRef<HTMLDivElement | null>(null);
    const images = useDeckImages(slides);

    useEffect(() => {
        let alive = true;
        setSlides(null);
        setFailed(false);
        setIndex(0);
        void (async () => {
            try {
                const file = await fetch(src);
                if (!file.ok) throw new Error("read failed");
                const query = new URLSearchParams({ w: String(BUILD_WIDTH) });
                if (token) query.set("t", token);
                const built = await fetch(`/api/drive/slides?${query.toString()}`, {
                    method: "POST",
                    body: await file.arrayBuffer()
                });
                if (!built.ok) throw new Error("render failed");
                const answer = (await built.json()) as { slides?: RenderSlide[] };
                if (alive) setSlides(answer.slides ?? []);
            } catch {
                if (alive) setFailed(true);
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

    if (failed) return <ViewerError>This presentation could not be rendered.</ViewerError>;
    if (!slides) return <Loading />;
    if (slides.length === 0)
        return <ViewerError>This presentation has no slides.</ViewerError>;

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

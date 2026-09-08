"use client";

/**
 * A diagram, drawn.
 *
 * Excalidraw for the canvas - MIT, React, and the only complete open-source
 * whiteboard that can actually be shipped inside a product. The one that looks
 * nicer changed its licence in 2025 and now wants a commercial agreement or a
 * watermark on somebody else's drawing, which is not a thing Polaris will put on
 * a screen.
 *
 * **Shapes are merged one at a time, not scene at a time.** Each element lives
 * under its own key in a shared map, so two people moving two different boxes is
 * two independent changes and neither overwrites the other. Inside one shape
 * there is nothing to merge - two people dragging one rectangle produce two
 * whole rectangles - so the later version wins, by the rule on the shape itself:
 * see `lib/office/scene.ts`, which is where all of that reasoning lives.
 *
 * Loaded only in the browser. Excalidraw reaches for `window` as it initialises,
 * and a canvas rendered on a server is an error nobody can read.
 */

import * as Y from "yjs";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import "@excalidraw/excalidraw/index.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { reconcileScene, type SceneElement } from "@/lib/office/scene";
import { useRegisterExporter } from "@/app/(app)/office/export-slot";
import { useOfficeDocument, REMOTE } from "@/app/(app)/office/use-office-document";

const Excalidraw = dynamic(
    async () => (await import("@excalidraw/excalidraw")).Excalidraw,
    {
        ssr: false,
        loading: () => (
            <p className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                Opening the canvas
            </p>
        )
    }
);

/** Where the shapes live in the shared document. A map keyed by element id
 *  rather than an array: an array would make every move a change to the whole
 *  list, and two people drawing at once a fight over its order. */
const SHAPES = "shapes";

/** The scene's own settings - the background, the grid. One shared map, because
 *  they are the drawing's rather than each viewer's. */
const SCENE = "scene";

export function DiagramEditor({
    documentId,
    content,
    editable
}: {
    documentId: string;
    content: number[] | null;
    editable: boolean;
}) {
    const { doc } = useOfficeDocument({ documentId, content, editable });
    const shapes = useMemo(() => doc.getMap<SceneElement>(SHAPES), [doc]);
    const scene = useMemo(() => doc.getMap<unknown>(SCENE), [doc]);

    /** Excalidraw's own handle, once it is up. Held rather than in state: it is
     *  an imperative API and re-rendering on it would remount the canvas. */
    const api = useRef<{
        updateScene: (scene: { elements: readonly SceneElement[] }) => void;
        getSceneElements: () => readonly SceneElement[];
        getAppState: () => Record<string, unknown>;
        getFiles: () => Record<string, unknown>;
    } | null>(null);

    /**
     * The drawing, as a picture.
     *
     * Registered with the chrome above rather than exported by a button here,
     * because it belongs on the same menu as every other format - and it is the
     * one format the server cannot make: rendering a drawing means having drawn
     * it, and the thing that has is this canvas.
     *
     * Excalidraw's own exporters are loaded on demand for the same reason
     * everything else about it is: they pull in the whole renderer, and nobody
     * who never presses Export should pay for that.
     */
    useRegisterExporter(async (format) => {
        const handle = api.current;
        if (!handle) return null;
        const { exportToBlob, exportToSvg } = await import("@excalidraw/excalidraw");
        const scene = {
            elements: handle.getSceneElements(),
            appState: { ...handle.getAppState(), exportBackground: true },
            files: handle.getFiles()
        };
        if (format === "png") {
            return exportToBlob({ ...scene, mimeType: "image/png" } as never);
        }
        if (format === "svg") {
            const svg = await exportToSvg(scene as never);
            // Serialized here rather than handed over as a node: what the menu
            // saves is a file, and an SVG element is not one.
            return new Blob([new XMLSerializer().serializeToString(svg)], {
                type: "image/svg+xml"
            });
        }
        return null;
    });

    /** Whether the change being handled came off the wire. Excalidraw calls
     *  `onChange` when the scene is updated programmatically too, and without
     *  this every arriving shape would be sent straight back out. */
    const applying = useRef(false);

    /** What was last written for each shape, so an unchanged one is not written
     *  again. Excalidraw fires `onChange` on pointer moves that changed nothing
     *  at all - a selection, a hover - and writing on those is a write per
     *  frame. */
    const written = useRef(new Map<string, number>());

    /**
     * The scene as the canvas wants it.
     *
     * Cast at this one boundary on purpose. `lib/office/scene.ts` describes a
     * shape by the four fields the merge actually reads, so the rule can be
     * tested without dragging a canvas library into a unit test; Excalidraw
     * describes it by all twenty-one. They are the same objects - these came out
     * of that canvas - and the cast is where the two descriptions meet.
     */
    const initial = useMemo(
        () => ({
            elements: [...shapes.values()] as never,
            appState: {
                // The canvas draws its own background, and on a dark theme a
                // white one is a rectangle of daylight in the middle of the app.
                viewBackgroundColor: "transparent",
                ...((scene.get("appState") as object | undefined) ?? {})
            },
            scrollToContent: true
        }),
        // Read once, when the canvas is built. Everything after arrives through
        // the observer below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []
    );

    /** Somebody else drew something. */
    useEffect(() => {
        const observe = (_event: unknown, transaction: Y.Transaction): void => {
            // Its own writing, coming back through the map.
            if (transaction.origin !== REMOTE) return;
            const handle = api.current;
            if (!handle) return;
            applying.current = true;
            try {
                handle.updateScene({
                    elements: reconcileScene(handle.getSceneElements(), [...shapes.values()])
                });
            } finally {
                applying.current = false;
            }
        };
        shapes.observeDeep(observe);
        return () => shapes.unobserveDeep(observe);
    }, [shapes]);

    const onChange = useCallback(
        (elements: readonly SceneElement[]) => {
            if (!editable || applying.current) return;
            doc.transact(() => {
                const seen = new Set<string>();
                for (const element of elements) {
                    seen.add(element.id);
                    const version = element.version ?? 0;
                    if (written.current.get(element.id) === version) continue;
                    written.current.set(element.id, version);
                    shapes.set(element.id, element);
                }
                // A shape this canvas no longer has at all - undone rather than
                // deleted, which Excalidraw does not mark. Anything it deleted
                // is still in `elements` carrying `isDeleted`, and that has to
                // travel: a deletion is a version of the shape, and dropping it
                // is how a shape somebody else deleted comes back.
                for (const id of [...shapes.keys()]) {
                    if (!seen.has(id)) {
                        shapes.delete(id);
                        written.current.delete(id);
                    }
                }
            });
        },
        [doc, editable, shapes]
    );

    return (
        <div className="min-h-0 flex-1">
            {/* Excalidraw measures its own container, so it needs one with a
                height rather than one that grows to fit it. */}
            <div className="h-full w-full [&_.excalidraw]:!bg-transparent">
                <Excalidraw
                    initialData={initial}
                    viewModeEnabled={!editable}
                    excalidrawAPI={(handle: unknown) => {
                        api.current = handle as typeof api.current;
                    }}
                    onChange={onChange as never}
                    UIOptions={{
                        canvasActions: {
                            // Saving, loading and exporting are Polaris' own -
                            // the document is stored here and leaves through the
                            // Export menu above, not through a second set of
                            // buttons that write to somebody's Downloads folder.
                            loadScene: false,
                            saveToActiveFile: false,
                            export: false,
                            saveAsImage: false
                        }
                    }}
                />
            </div>
        </div>
    );
}

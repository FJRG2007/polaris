"use client";

/**
 * The slide, as the room sees it, kept on the presenter's slide.
 *
 * Read-only and live: the deck arrives over the same stream the editor uses,
 * so a typo fixed in the editor during the talk is fixed on the projector too.
 * Which slide is shown is the presenter view's to decide (`show-channel.ts`);
 * a click or a key here asks it to turn.
 */

import * as deck from "@/lib/office/deck";
import * as edits from "@/app/(app)/office/p/[id]/deck-edits";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Present, type ShowStep } from "@/app/(app)/office/p/[id]/present";
import { useOfficeDocument } from "@/app/(app)/office/use-office-document";
import { ImageSourceProvider } from "@/app/(app)/office/p/[id]/slide-canvas";
import { openShowChannel, type ShowChannel } from "@/app/(app)/office/p/[id]/show-channel";

export function AudienceShow({
    documentId,
    content
}: {
    documentId: string;
    content: number[] | null;
}) {
    const { doc } = useOfficeDocument({ documentId, content, editable: false });
    const version = edits.useDocumentVersion(doc);
    const slides = useMemo(() => edits.slidesOf(doc).toArray(), [doc, version]);
    const bySlide = useMemo(
        () => deck.groupBySlide(new Map(edits.boxesOf(doc).entries())),
        [doc, version]
    );
    const source = useCallback(
        (src: string) => edits.imageSource(doc, src),
        // A picture that arrives later is a new version of the document.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [doc, version]
    );
    const [at, setAt] = useState(0);
    const channel = useRef<ShowChannel | null>(null);

    useEffect(() => {
        const opened = openShowChannel(documentId, (one) => {
            if (one.kind === "at") setAt(one.at);
            else if (one.kind === "end") window.close();
        });
        channel.current = opened;
        opened?.send({ kind: "hello" });
        return () => {
            opened?.close();
            channel.current = null;
        };
    }, [documentId]);

    const go = useCallback((step: ShowStep) => channel.current?.send({ kind: "go", to: step }), []);
    const driven = useMemo(() => ({ at, go }), [at, go]);

    if (slides.length === 0) return <div className="fixed inset-0 bg-black" />;
    return (
        <ImageSourceProvider source={source}>
            <Present
                slides={slides}
                bySlide={bySlide}
                from={0}
                driven={driven}
                onClose={() => window.close()}
            />
        </ImageSourceProvider>
    );
}

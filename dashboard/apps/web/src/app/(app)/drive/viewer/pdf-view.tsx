"use client";

/**
 * PDF preview. The document, its library and its stylesheet load only when a
 * PDF is actually opened, and never on the server: pdf.js reaches for the DOM
 * as it loads, and there is none there.
 */

import dynamic from "next/dynamic";
import { Loading } from "./status";
import type { ViewerTarget } from "./types";

const PdfDocument = dynamic(() => import("./pdf-document"), {
    ssr: false,
    loading: () => <Loading />
});

export function PdfView({
    src,
    target,
    readOnly = false,
    onSaved
}: {
    src: string;
    target: ViewerTarget;
    readOnly?: boolean;
    onSaved?: (name: string) => void;
}) {
    // Keyed on the file: opening another document in the same place is a new
    // viewer, not the old one told to load different bytes. The tool in hand,
    // the panel and - the one that would be a defect rather than an
    // inconvenience - what counts as an unsaved change all belong to the
    // document they were measured against.
    return (
        <PdfDocument key={src} src={src} target={target} readOnly={readOnly} onSaved={onSaved} />
    );
}

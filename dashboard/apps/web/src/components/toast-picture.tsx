"use client";

import { useState } from "react";

/** The picture on a note, gone rather than broken when it cannot be loaded, so
 *  the note falls back to its words. */
export function ToastPicture({ src, alt }: { readonly src: string; readonly alt: string }) {
    const [failed, setFailed] = useState(false);
    if (failed) return null;
    return (
        // eslint-disable-next-line @next/next/no-img-element -- an authenticated attachment route, not an optimisable asset
        <img
            src={src}
            alt={alt}
            onError={() => setFailed(true)}
            className="max-h-40 w-auto max-w-full rounded-md object-contain"
        />
    );
}

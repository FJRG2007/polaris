"use client";

import { useEffect, useState } from "react";

/** The message as text, or as sanitized Markdown when the sender marked it so. */
export function AlertBody({ message, markdown }: { message: string; markdown: boolean }) {
    const [html, setHtml] = useState<string | null>(null);
    useEffect(() => {
        if (!markdown) return;
        let live = true;
        void import("@/app/(app)/drive/viewer/markdown-render")
            .then(({ renderMarkdown }) => renderMarkdown(message))
            .then((rendered) => live && setHtml(rendered))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [markdown, message]);
    if (markdown && html !== null) {
        // Sanitized by renderMarkdown (DOMPurify), the same as Drive's viewer.
        return <div className="prose prose-sm max-w-none break-words dark:prose-invert" dangerouslySetInnerHTML={{ __html: html }} />;
    }
    return <p className="whitespace-pre-wrap break-words text-sm">{message}</p>;
}

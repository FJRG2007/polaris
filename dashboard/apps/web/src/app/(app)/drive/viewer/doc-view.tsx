"use client";

/**
 * Word documents rendered to styled HTML with mammoth (dynamically imported).
 * Read-only on purpose: no open-source round-trip writes a .docx back without
 * losing the original styling, so the document is never rewritten from here.
 */

import { useEffect, useState } from "react";
import { Loading, ViewerError } from "./status";

export function DocView({ src }: { src: string }) {
    const [html, setHtml] = useState<string | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let alive = true;
        setHtml(null);
        setError(false);
        void (async () => {
            try {
                const [mammoth, response] = await Promise.all([import("mammoth"), fetch(src)]);
                const arrayBuffer = await response.arrayBuffer();
                if (!alive) return;
                const result = await mammoth.convertToHtml({ arrayBuffer });
                if (alive) setHtml(result.value);
            } catch {
                if (alive) setError(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [src]);

    if (error) return <ViewerError>This document could not be rendered.</ViewerError>;
    if (html === null) return <Loading />;
    return (
        <div className="mx-auto max-w-3xl p-6">
            <style>{`
                .doc-preview { line-height: 1.6; }
                .doc-preview h1 { font-size: 1.5rem; font-weight: 600; margin: 1rem 0 0.5rem; }
                .doc-preview h2 { font-size: 1.25rem; font-weight: 600; margin: 1rem 0 0.5rem; }
                .doc-preview p { margin: 0.5rem 0; }
                .doc-preview ul, .doc-preview ol { margin: 0.5rem 0 0.5rem 1.5rem; }
                .doc-preview table { border-collapse: collapse; margin: 0.5rem 0; }
                .doc-preview td, .doc-preview th { border: 1px solid hsl(var(--border)); padding: 4px 8px; }
                .doc-preview a { color: hsl(var(--primary)); text-decoration: underline; }
            `}</style>
            <div className="doc-preview text-sm" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
    );
}

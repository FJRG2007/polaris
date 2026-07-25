"use client";

/**
 * PDF preview. Viewing stays on the browser's native viewer (an inline iframe:
 * crisp, selectable text, search, zoom and print, with no library weight);
 * editing swaps in the pdf.js editor, which - along with its stylesheet - is
 * loaded only when it is actually opened.
 */

import { useState } from "react";
import dynamic from "next/dynamic";
import { Pencil } from "lucide-react";
import { Button } from "@polaris/ui";
import { Loading } from "./status";
import type { ViewerTarget } from "./types";

const PdfEditor = dynamic(() => import("./pdf-editor"), {
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
    const [editing, setEditing] = useState(false);

    if (editing) {
        return (
            <PdfEditor
                src={src}
                target={target}
                onSaved={onSaved}
                onExit={() => setEditing(false)}
            />
        );
    }

    return (
        <div className="flex max-h-[80vh] flex-col">
            {!readOnly ? (
                <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">PDF</span>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => setEditing(true)}
                    >
                        <Pencil className="size-4" />
                        Edit
                    </Button>
                </div>
            ) : null}
            <iframe title="PDF preview" src={src} className="h-[80vh] w-full border-0" />
        </div>
    );
}

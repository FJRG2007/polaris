"use client";

/**
 * The metadata behind one audit entry. Most rows carry a short object that fits
 * on the line; the ones that do not are read in full here rather than being
 * silently cut off, which is the point of an audit trail.
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@polaris/ui";
import { isValidJson, JsonView } from "@/components/json-view";

export function ActivityDetails({ metadata }: { metadata: string }) {
    const [open, setOpen] = useState(false);

    // Anything that is not a document has nothing to expand into: the line is
    // already the whole of it.
    if (metadata.trim() === "" || !isValidJson(metadata)) {
        return <span className="block max-w-md truncate">{metadata}</span>;
    }

    return (
        <div className="max-w-md">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className="flex w-full items-center gap-1 text-left hover:text-foreground"
            >
                <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
                <span className="truncate font-mono">{metadata}</span>
            </button>
            {open ? <JsonView value={metadata} label="details" className="mt-1 max-h-72" /> : null}
        </div>
    );
}

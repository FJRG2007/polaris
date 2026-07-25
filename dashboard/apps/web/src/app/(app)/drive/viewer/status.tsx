"use client";

/** The loading and failure states every viewer renders while fetching bytes. */

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export function Loading() {
    return (
        <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading preview...
        </div>
    );
}

export function ViewerError({ children }: { children: ReactNode }) {
    return <p className="p-8 text-center text-sm text-danger">{children}</p>;
}

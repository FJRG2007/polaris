"use client";

/**
 * The foot of an infinitely scrolled list: it asks for the next page as soon as it
 * comes within a screen of the viewport, and stays a real button for whoever
 * scrolls with a keyboard or a reader that never triggers the observer.
 */

import { useEffect, useRef } from "react";
import { Button } from "@polaris/ui";

export function LoadMore({ onMore, loading, label }: { onMore: () => void; loading: boolean; label: string }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const latest = useRef(onMore);
    latest.current = onMore;
    useEffect(() => {
        const node = ref.current;
        if (!node || loading || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) latest.current();
            },
            { rootMargin: "100% 0px" }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [loading]);
    return (
        <div ref={ref} className="flex justify-center py-1">
            <Button size="sm" variant="ghost" disabled={loading} onClick={onMore}>
                {label}
            </Button>
        </div>
    );
}

"use client";

/**
 * Tells the page outside the top bar which screen widths the bar has room for.
 *
 * A control that lives in the bar at `tb-md:` and in the page below that - the
 * Deploy project and environment pickers - needs its page copy to switch at the
 * same point, but the page is not inside the bar's container, so `tb-*` never
 * matches there and `md:` measures the window, which in the desktop app is wider
 * than the bar by the window buttons. This reads the bar's frame (its content
 * box, the same width `tb-*` queries) and lists on `<html>` the screens it is
 * narrower than, which the `under-tb-*` variants match: `md:hidden
 * under-tb-md:flex` shows the page copy exactly while the bar's copy is hidden.
 */

import { useEffect, useRef } from "react";
import { titlebarUnder } from "./titlebar-screens";

export function TitlebarWidths() {
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        const frame = ref.current?.parentElement;
        if (!frame || typeof ResizeObserver === "undefined") return;
        const root = document.documentElement;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) root.dataset.titlebarUnder = titlebarUnder(entry.contentRect.width);
        });
        observer.observe(frame);
        return () => {
            observer.disconnect();
            delete root.dataset.titlebarUnder;
        };
    }, []);
    return <span ref={ref} hidden />;
}

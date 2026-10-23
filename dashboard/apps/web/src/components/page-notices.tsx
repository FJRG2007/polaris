"use client";

/**
 * The shell's notices above every page, and the height they take published as
 * `--page-notice-height`, which `--notice-height` adds to the connection
 * strip's for the screens that fill the window to subtract (see PAGE_NOTICES).
 * Measured rather than assumed: a notice wraps to three lines at
 * phone width and to one on a desktop, and a disk warning grows a line while a
 * move runs.
 */

import { PAGE_NOTICES } from "@polaris/ui";
import { useEffect, useRef, type ReactNode } from "react";

const VARIABLE = "--page-notice-height";

export function PageNotices({ children }: { children: ReactNode }) {
    const strip = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const element = strip.current;
        if (!element) return;
        const root = document.documentElement;
        const publish = () => root.style.setProperty(VARIABLE, `${element.offsetHeight}px`);
        publish();
        const observer = new ResizeObserver(publish);
        observer.observe(element);
        return () => {
            observer.disconnect();
            root.style.removeProperty(VARIABLE);
        };
    }, []);

    return (
        <div ref={strip} className={PAGE_NOTICES}>
            {children}
        </div>
    );
}

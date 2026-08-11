"use client";

/**
 * A section that fades up as it comes into view.
 *
 * Deliberately additive: the content renders visible, and the hidden-then-revealed
 * state is only ever applied after this mounts. Without JavaScript, before hydration,
 * and for a crawler or a review desk reading the markup, the page is simply the page -
 * which for these pages in particular is not a nicety. They exist to be readable
 * signed out by someone verifying the app, and an effect that can hide the text if it
 * fails to run would be the one bug that matters here.
 *
 * Motion is skipped entirely under `prefers-reduced-motion`, rather than shortened.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

export function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    /** Whether this is animating at all. False on the server and on the first client
     *  render, so the markup both produce is identical and hydration has nothing to
     *  reconcile. */
    const [animating, setAnimating] = useState(false);
    const [shown, setShown] = useState(false);

    useEffect(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const node = ref.current;
        if (!node) return;
        // Already in view on load - the top of the page - is shown rather than
        // animated: fading in what the reader is already looking at reads as a stutter.
        if (node.getBoundingClientRect().top < window.innerHeight) {
            setShown(true);
            setAnimating(true);
            return;
        }
        setAnimating(true);
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    setShown(true);
                    observer.disconnect();
                }
            },
            // A little before the edge, so a section has finished arriving by the time
            // it is being read rather than resolving under the reader's eyes.
            { rootMargin: "0px 0px -10% 0px" }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    return (
        <div
            ref={ref}
            className={`${className} ${
                animating
                    ? `transition-[opacity,transform] duration-700 ease-out ${
                          shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
                      }`
                    : ""
            }`}
        >
            {children}
        </div>
    );
}

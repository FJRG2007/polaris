"use client";

/**
 * Inertial scrolling for the pages outside the login.
 *
 * The wheel moves a target and the page eases towards it, so a flick keeps gliding
 * for a moment after the fingers stop. It is the difference between a page that
 * jumps in notches and one that carries weight, and it cannot be had from CSS:
 * `scroll-behavior: smooth` only eases the jumps something else asks for - an anchor,
 * a `scrollTo` - and does nothing at all to the wheel.
 *
 * Only the public pages. The dashboard has virtualised lists and panes that scroll
 * inside themselves, and taking the wheel away from those to hand it to one animation
 * loop is how a file list starts fighting the page it sits in.
 *
 * Nothing renders. It drives the document that is already there, so the markup and
 * the first paint are exactly what the server sent.
 */

// Every rule is scoped to `html.lenis`, a class only added while the effect is
// actually running - so a reader on reduced motion loads a few hundred inert bytes
// and gets the browser's own scrolling, unaltered.
import "lenis/dist/lenis.css";
import { useEffect } from "react";

/** How much of the remaining distance is covered each frame. Lower glides longer;
 *  this is close enough to the reference to feel the same without the page still
 *  drifting once the reader has started reading. */
const LERP = 0.1;

export function SmoothScroll() {
    useEffect(() => {
        // Someone who asked their system for less motion is asking for this too:
        // inertia is motion they did not initiate and cannot stop by letting go, and
        // it is a common vestibular trigger. Native scrolling for them, which is not
        // a lesser version of the page - it is the page without an effect on it.
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
        if (reduced.matches) return;

        let lenis: { raf: (time: number) => void; destroy: () => void } | null = null;
        let frame = 0;
        let cancelled = false;

        // Loaded on demand so it is fetched with the page it affects rather than
        // parsed by every route in the bundle - and so a failure to load costs the
        // effect, never the page.
        void import("lenis").then(({ default: Lenis }) => {
            if (cancelled) return;
            lenis = new Lenis({ lerp: LERP });
            const tick = (time: number): void => {
                lenis?.raf(time);
                frame = requestAnimationFrame(tick);
            };
            frame = requestAnimationFrame(tick);
        });

        return () => {
            cancelled = true;
            cancelAnimationFrame(frame);
            lenis?.destroy();
        };
    }, []);

    return null;
}

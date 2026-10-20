"use client";

/**
 * What every animated Polar piece shares: whether motion is welcome, whether
 * the page is dark, the colour a theme token holds, and one animation loop per
 * element that stops while the element is offscreen or the tab is hidden.
 *
 * The theme is read from the tokens themselves (`--foreground`), not from a
 * class name, so the light, dark and follow-the-system themes all resolve the
 * same way the stylesheet does.
 */

import { useEffect, useState } from "react";

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

/** Whether reduced motion is asked for right now, read without waiting for a render. */
export function prefersReducedMotion(): boolean {
    return (
        typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
    );
}

/**
 * Live `prefers-reduced-motion`: true means draw one still frame. It starts
 * false so the server's markup matches; an effect that animates also checks
 * `prefersReducedMotion()` so its first run never starts a loop it must stop.
 */
export function useReducedMotion(): boolean {
    const [reduced, setReduced] = useState(false);
    useEffect(() => {
        if (typeof matchMedia === "undefined") return;
        const query = matchMedia("(prefers-reduced-motion: reduce)");
        setReduced(query.matches);
        const change = (event: MediaQueryListEvent) => setReduced(event.matches);
        query.addEventListener("change", change);
        return () => query.removeEventListener("change", change);
    }, []);
    return reduced;
}

/** An `H S% L%` token triple as RGB, or null when it is not one. */
export function hslTriple(value: string): Rgb | null {
    const match = value.trim().match(/^(-?[\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%/);
    if (!match) return null;
    const h = (((Number(match[1]) % 360) + 360) % 360) / 360;
    const s = Number(match[2]) / 100;
    const l = Number(match[3]) / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (offset: number) => {
        let t = h + offset;
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        const v =
            t < 1 / 6
                ? p + (q - p) * 6 * t
                : t < 1 / 2
                  ? q
                  : t < 2 / 3
                    ? p + (q - p) * (2 / 3 - t) * 6
                    : p;
        return Math.round(v * 255);
    };
    return { r: channel(1 / 3), g: channel(0), b: channel(-1 / 3) };
}

/** The RGB a theme token (`--primary`, `--foreground`) holds where `el` sits. */
export function tokenRgb(el: Element, token: string): Rgb | null {
    return hslTriple(getComputedStyle(el).getPropertyValue(token));
}

/** Whether the theme in force at `el` is a dark one: its text is light. */
export function themeIsDark(el: Element): boolean {
    const match = getComputedStyle(el)
        .getPropertyValue("--foreground")
        .trim()
        .match(/([\d.]+)%\s*$/);
    return match ? Number(match[1]) > 50 : true;
}

/**
 * A number that changes whenever the theme may have: the root's class or
 * `data-theme` flips, or the system scheme does. Effects that read tokens list
 * it as a dependency so they read them again.
 */
export function useThemeVersion(): number {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const bump = () => setVersion((current) => current + 1);
        const scheme =
            typeof matchMedia === "undefined" ? null : matchMedia("(prefers-color-scheme: dark)");
        scheme?.addEventListener("change", bump);
        const observer =
            typeof MutationObserver === "undefined" ? null : new MutationObserver(bump);
        observer?.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "data-theme", "style"]
        });
        return () => {
            scheme?.removeEventListener("change", bump);
            observer?.disconnect();
        };
    }, []);
    return version;
}

/** The device pixel ratio a canvas is drawn at, capped where more is wasted. */
export function canvasRatio(): number {
    return Math.min(2, (typeof devicePixelRatio !== "undefined" && devicePixelRatio) || 1);
}

/**
 * Run `frame(seconds)` on every animation frame while `el` is on screen and
 * the tab is visible. One loop per element; the returned function stops it for
 * good. `frame` is called once straight away so a paused element still shows.
 */
export function runWhileVisible(el: Element, frame: (seconds: number) => void): () => void {
    let raf = 0;
    let running = false;
    let visible = true;
    const loop = () => {
        frame(performance.now() / 1000);
        if (running) raf = requestAnimationFrame(loop);
    };
    const start = () => {
        if (running) return;
        running = true;
        raf = requestAnimationFrame(loop);
    };
    const stop = () => {
        running = false;
        cancelAnimationFrame(raf);
    };
    frame(performance.now() / 1000);
    const observer =
        typeof IntersectionObserver === "undefined"
            ? null
            : new IntersectionObserver(([entry]) => {
                  visible = !!entry?.isIntersecting;
                  if (visible && document.visibilityState !== "hidden") start();
                  else stop();
              });
    observer?.observe(el);
    const onVisibility = () => {
        if (document.visibilityState === "hidden") stop();
        else if (visible) start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (!observer) start();
    return () => {
        stop();
        observer?.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
    };
}

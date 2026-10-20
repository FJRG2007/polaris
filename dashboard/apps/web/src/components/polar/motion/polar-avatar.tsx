"use client";

/**
 * Polar's animated avatar: the bear from Polar's mark as a living 2D-canvas
 * figure, after Libraries.dev's bot avatars (MIT, see LICENSE beside this
 * file). Awake it looks around and now and then jumps; at work it hops; asleep
 * its head drops and its eyes close. The eyes follow the pointer, and a click
 * makes it hop. Reduced motion draws the state's still pose and nothing else.
 *
 * The canvas overscans its layout box so a hop can leave the box unclipped;
 * the box itself is exactly `size` square, so it sits in a row like an icon.
 */

import { cn } from "@polaris/ui";
import { drawAvatar, OVERSCAN, RISE } from "./avatar-draw";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Sim, restPose, type AvatarState } from "./avatar-engine";
import { reachability, subscribeReachability } from "@/lib/reachability";
import {
    canvasRatio,
    prefersReducedMotion,
    runWhileVisible,
    useReducedMotion
} from "./motion-runtime";

/* The last pointer position on the page, NaN while it is away: one set of
   listeners for every avatar. */
const pointer = { x: Number.NaN, y: Number.NaN };
let wired = false;
function wirePointer() {
    if (wired || typeof document === "undefined") return;
    wired = true;
    const away = () => {
        pointer.x = Number.NaN;
        pointer.y = Number.NaN;
    };
    document.addEventListener(
        "pointermove",
        (event) => {
            pointer.x = event.clientX;
            pointer.y = event.clientY;
        },
        { passive: true }
    );
    document.addEventListener("pointerleave", away);
    window.addEventListener("blur", away);
}

/* how far the pointer's pull reaches, in head widths */
const REACH = 3;

/* A 0-1 seed per avatar, so two side by side never blink in step. */
let seeds = 0;
const nextSeed = () => ((seeds++ * 0.618034) % 1) + 0.0001;

function subscribeOnline(listener: () => void): () => void {
    window.addEventListener("online", listener);
    window.addEventListener("offline", listener);
    const off = subscribeReachability(listener);
    return () => {
        window.removeEventListener("online", listener);
        window.removeEventListener("offline", listener);
        off();
    };
}

/** Whether Polaris can be reached from this tab right now. */
export function usePolarOnline(): boolean {
    return useSyncExternalStore(
        subscribeOnline,
        () => navigator.onLine !== false && reachability().reachable,
        () => true
    );
}

export function PolarAvatar({
    state = "idle",
    size = 24,
    label,
    className
}: {
    state?: AvatarState;
    /** The layout box in CSS px. */
    size?: number;
    /** Accessible name; the state's own words when absent. */
    label?: string;
    className?: string;
}) {
    const t = useTranslations("polar");
    const ref = useRef<HTMLCanvasElement | null>(null);
    const sim = useRef<Sim | null>(null);
    const reduced = useReducedMotion();

    useEffect(() => {
        const canvas = ref.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        if (!sim.current) sim.current = new Sim(nextSeed(), state);
        else sim.current.setState(state);
        const rig = sim.current;
        let box = size;
        let ratio = canvasRatio();
        const fit = () => {
            box = canvas.clientWidth / OVERSCAN || box;
            ratio = canvasRatio();
            const want = Math.round(box * OVERSCAN * ratio);
            if (canvas.width !== want || canvas.height !== want) {
                canvas.width = want;
                canvas.height = want;
            }
        };
        fit();
        const still = reduced || prefersReducedMotion();
        const paintStill = () => drawAvatar(ctx, box, ratio, restPose(state), 0);
        const resize =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(() => {
                      fit();
                      if (still) paintStill();
                  });
        resize?.observe(canvas);
        if (still) {
            paintStill();
            return () => resize?.disconnect();
        }
        wirePointer();
        let last = 0;
        const stop = runWhileVisible(canvas, (seconds) => {
            const dt = last ? Math.min(0.1, Math.max(0, seconds - last)) : 0;
            last = seconds;
            if (Number.isNaN(pointer.x)) rig.setPointer(0, 0, 0);
            else {
                const r = canvas.getBoundingClientRect();
                const head = r.width / OVERSCAN || 1;
                const dx = (pointer.x - (r.left + r.width / 2)) / head;
                const dy = (pointer.y - (r.top + r.height / 2 + RISE * head)) / head;
                const d = Math.hypot(dx, dy);
                /* full pull up close, gone by REACH */
                const strength = d < 1 ? 1 : d > REACH ? 0 : 1 - (d - 1) / (REACH - 1);
                rig.setPointer(dx / Math.max(1, d), dy / Math.max(1, d), strength);
            }
            rig.update(dt);
            drawAvatar(ctx, box, ratio, rig.pose, seconds);
        });
        return () => {
            stop();
            resize?.disconnect();
        };
    }, [state, size, reduced]);

    const side = (OVERSCAN - 1) / 2;
    return (
        <span
            className={cn("relative inline-block shrink-0 align-middle", className)}
            style={{ width: size, height: size }}
        >
            <canvas
                ref={ref}
                role="img"
                aria-label={label ?? t(`avatar.${state}`)}
                data-avatar-state={state}
                data-still={reduced ? "" : undefined}
                onClick={() => {
                    if (!reduced && !prefersReducedMotion()) sim.current?.poke();
                }}
                className="absolute block"
                style={{
                    width: size * OVERSCAN,
                    height: size * OVERSCAN,
                    left: -size * side,
                    top: -size * (side + RISE)
                }}
            />
        </span>
    );
}

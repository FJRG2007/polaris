"use client";

/**
 * The arrows for a camera that moves.
 *
 * Drawn over the picture while it is playing, and only for a camera that
 * answered ONVIF: an arrow that does nothing is worse than no arrow.
 *
 * Movement is continuous, so every press is a start and every release is a stop.
 * The stop is sent on release, on the pointer leaving the button, and when the
 * component goes away - a camera left panning keeps panning, and it is the kind
 * of bug somebody finds a day later pointed at a wall.
 */

import { cn } from "@polaris/ui";
import * as actions from "./actions";
import type { PtzDirection } from "@/lib/home/ptz";
import { useCallback, useEffect, useRef } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Minus, Plus } from "lucide-react";

const ARROWS: { direction: PtzDirection; label: string; icon: typeof ArrowUp; className: string }[] = [
    { direction: "up", label: "Up", icon: ArrowUp, className: "col-start-2 row-start-1" },
    { direction: "left", label: "Left", icon: ArrowLeft, className: "col-start-1 row-start-2" },
    { direction: "right", label: "Right", icon: ArrowRight, className: "col-start-3 row-start-2" },
    { direction: "down", label: "Down", icon: ArrowDown, className: "col-start-2 row-start-3" },
    { direction: "in", label: "Zoom in", icon: Plus, className: "col-start-3 row-start-1" },
    { direction: "out", label: "Zoom out", icon: Minus, className: "col-start-1 row-start-1" }
];

export function PtzPad({ cameraId }: { cameraId: string }) {
    // Whether this pad has a camera moving right now, so the cleanup only sends a
    // stop when there is something to stop.
    const moving = useRef(false);

    const stop = useCallback(() => {
        if (!moving.current) return;
        moving.current = false;
        void actions.ptzStopAction(cameraId).catch(() => null);
    }, [cameraId]);

    useEffect(() => stop, [stop]);

    // A pointer released outside the button never fires its own release, and the
    // camera would keep going. The window hears about it either way.
    useEffect(() => {
        window.addEventListener("pointerup", stop);
        window.addEventListener("blur", stop);
        return () => {
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("blur", stop);
        };
    }, [stop]);

    const start = (direction: PtzDirection) => {
        moving.current = true;
        void actions.ptzMoveAction(cameraId, direction).catch(() => null);
    };

    return (
        <div
            className="absolute bottom-2 right-2 grid grid-cols-3 grid-rows-3 gap-1 rounded-lg bg-black/50 p-1 backdrop-blur-sm"
            // The tile below opens and closes the stream on click; an arrow is
            // not that.
            onClick={(event) => event.stopPropagation()}
        >
            {ARROWS.map((arrow) => (
                <button
                    key={arrow.direction}
                    type="button"
                    aria-label={arrow.label}
                    title={arrow.label}
                    className={cn(
                        "flex size-7 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white",
                        arrow.className
                    )}
                    onPointerDown={() => start(arrow.direction)}
                    onPointerUp={stop}
                    onPointerLeave={stop}
                    // Held keys are the same gesture from a keyboard, and a camera
                    // that can only be pointed with a mouse is one half the house
                    // cannot use.
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") start(arrow.direction);
                    }}
                    onKeyUp={stop}
                >
                    <arrow.icon className="size-3.5 shrink-0" />
                </button>
            ))}
        </div>
    );
}

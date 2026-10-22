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
 *
 * On a camera with no privacy mode of its own, two more buttons save where it
 * points now as the place it turns to when it goes private, and forget it.
 */

import { cn, useToast } from "@polaris/ui";
import * as actions from "./actions";
import { usePlacesT } from "./use-places-t";
import type { PtzDirection } from "../lib/ptz";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    Minus,
    Plus,
    Shield,
    ShieldOff
} from "lucide-react";

const ARROWS: {
    direction: PtzDirection;
    label: "up" | "left" | "right" | "down" | "in" | "out";
    icon: typeof ArrowUp;
    className: string;
}[] = [
    { direction: "up", label: "up", icon: ArrowUp, className: "col-start-2 row-start-1" },
    { direction: "left", label: "left", icon: ArrowLeft, className: "col-start-1 row-start-2" },
    { direction: "right", label: "right", icon: ArrowRight, className: "col-start-3 row-start-2" },
    { direction: "down", label: "down", icon: ArrowDown, className: "col-start-2 row-start-3" },
    { direction: "in", label: "in", icon: Plus, className: "col-start-3 row-start-1" },
    { direction: "out", label: "out", icon: Minus, className: "col-start-1 row-start-1" }
];

export function PtzPad({
    cameraId,
    privacyPreset = null,
    onPrivacyPreset
}: {
    cameraId: string;
    /** The stored privacy position ("" for none), or null on a camera whose own
     *  privacy mode is used instead - which then gets no such buttons. */
    privacyPreset?: string | null;
    /** Told the stored position once the camera took it ("" once cleared). */
    onPrivacyPreset?: (preset: string) => void;
}) {
    const [preset, setPreset] = useState(privacyPreset);
    const [saving, setSaving] = useState(false);
    // Whether this pad has a camera moving right now, so the cleanup only sends a
    // stop when there is something to stop.
    const moving = useRef(false);
    const t = usePlacesT();
    const toast = useToast();

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

    // A move that did not reach the camera is said so: an arrow that silently
    // does nothing reads as a camera that cannot move, or one that is broken.
    const start = (direction: PtzDirection) => {
        moving.current = true;
        const key = `places-ptz-${cameraId}`;
        void actions
            .ptzMoveAction(cameraId, direction)
            .then((result) => {
                if (result.error) toast.show({ key, title: result.error });
            })
            .catch(() => toast.show({ key, title: t("ptz.failed") }));
    };

    // Shown as set at once; put back if the camera would not take it.
    const savePosition = async () => {
        if (saving) return;
        const before = preset;
        setSaving(true);
        setPreset(before || "pending");
        const key = `places-ptz-privacy-${cameraId}`;
        const result = await actions.savePrivacyPositionAction(cameraId).catch(() => null);
        setSaving(false);
        if (!result || result.error || !result.privacyPreset) {
            setPreset(before);
            toast.show({ key, title: result?.error ?? t("ptz.failed") });
            return;
        }
        setPreset(result.privacyPreset);
        onPrivacyPreset?.(result.privacyPreset);
        toast.show({ key, title: t("ptz.privacySaved") });
    };

    const clearPosition = async () => {
        if (saving) return;
        const before = preset;
        setSaving(true);
        setPreset("");
        const key = `places-ptz-privacy-${cameraId}`;
        const result = await actions.clearPrivacyPositionAction(cameraId).catch(() => null);
        setSaving(false);
        if (!result || result.error) {
            setPreset(before);
            toast.show({ key, title: result?.error ?? t("ptz.failed") });
            return;
        }
        onPrivacyPreset?.("");
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
                    aria-label={t(`ptz.${arrow.label}`)}
                    title={t(`ptz.${arrow.label}`)}
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
            {preset !== null ? (
                <button
                    type="button"
                    disabled={saving}
                    aria-label={preset ? t("ptz.privacyMove") : t("ptz.privacySave")}
                    title={preset ? t("ptz.privacyMove") : t("ptz.privacySave")}
                    className="col-start-1 row-start-3 flex size-7 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-50"
                    onClick={() => void savePosition()}
                >
                    <Shield className="size-3.5 shrink-0" />
                </button>
            ) : null}
            {preset ? (
                <button
                    type="button"
                    disabled={saving}
                    aria-label={t("ptz.privacyClear")}
                    title={t("ptz.privacyClear")}
                    className="col-start-3 row-start-3 flex size-7 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-50"
                    onClick={() => void clearPosition()}
                >
                    <ShieldOff className="size-3.5 shrink-0" />
                </button>
            ) : null}
        </div>
    );
}

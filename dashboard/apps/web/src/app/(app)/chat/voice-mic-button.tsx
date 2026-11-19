"use client";

/**
 * Record, and set up what records.
 *
 * A tap starts a recording that runs hands-free, finished by the recording
 * panel's own Send and bin - what a click on a computer has always done. A hold
 * is the phone messenger's voice note: it records while held and sends on
 * release, sliding left throws it away and sliding up locks it so the finger can
 * let go (`slideOutcome`, the same distances the dictation mic uses). Pointer
 * events, so a mouse held down does the same as a finger.
 *
 * The chevron beside it opens everything about the microphone - which one, how
 * much is done to what it hears, and how loud it goes out. Every choice behind
 * it is this browser's and is shared with calls and clips: see `MicSettings`.
 */

import { cn } from "@polaris/ui";
import { MicSettings } from "./mic-settings";
import { ChevronDown, Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { HOLD_MS, SHORTEST_VOICE_MS, slideOutcome } from "./dictation-logic";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@polaris/ui";

export function VoiceMicButton({
    disabled,
    recording,
    onStart,
    onStop,
    onCancel
}: {
    disabled: boolean;
    /** A recording is running, started by this button or any other way. */
    recording: boolean;
    onStart: () => void;
    /** Stop and send. */
    onStop: () => void;
    /** Stop and throw away. */
    onCancel: () => void;
}) {
    const t = useTranslations("chat");
    const [holding, setHolding] = useState(false);
    const press = useRef<{
        x: number;
        y: number;
        timer: ReturnType<typeof setTimeout> | null;
        /** When the hold began recording, or 0 while it is still a tap. */
        heldAt: number;
    } | null>(null);

    useEffect(
        () => () => {
            if (press.current?.timer) clearTimeout(press.current.timer);
        },
        []
    );

    const finish = (outcome: "send" | "cancel") => {
        const current = press.current;
        press.current = null;
        setHolding(false);
        if (!current?.heldAt) return;
        // A slip of the finger is not a message.
        if (outcome === "cancel" || Date.now() - current.heldAt < SHORTEST_VOICE_MS) onCancel();
        else onStop();
    };

    return (
        <span className="relative flex items-center">
            {holding && (
                <span
                    role="status"
                    className="absolute bottom-full end-0 z-10 mb-2 w-max max-w-[calc(100vw-2rem)] rounded-md bg-elevated px-2.5 py-1.5 text-xs shadow-modal"
                >
                    {t("dictation.slideHint")}
                </span>
            )}
            <button
                type="button"
                // Held down, it stays live through the recording it started; a
                // second press while one runs hands-free would open another.
                disabled={disabled || (recording && !holding)}
                aria-label={t("composer.recordAVoiceMessage")}
                title={t("composer.recordAVoiceMessage")}
                onPointerDown={(event) => {
                    if (event.button !== 0 || disabled || recording) return;
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    const current = {
                        x: event.clientX,
                        y: event.clientY,
                        timer: null as ReturnType<typeof setTimeout> | null,
                        heldAt: 0
                    };
                    press.current = current;
                    current.timer = setTimeout(() => {
                        current.timer = null;
                        if (press.current !== current) return;
                        current.heldAt = Date.now();
                        setHolding(true);
                        onStart();
                    }, HOLD_MS);
                }}
                onPointerMove={(event) => {
                    const current = press.current;
                    if (!current?.heldAt) return;
                    const outcome = slideOutcome(event.clientX - current.x, event.clientY - current.y);
                    if (outcome === "cancel") finish("cancel");
                    else if (outcome === "lock") {
                        // Recording on, finger free: the panel's buttons finish it.
                        press.current = null;
                        setHolding(false);
                    }
                }}
                onPointerUp={() => {
                    const current = press.current;
                    if (!current) return;
                    if (current.timer) {
                        clearTimeout(current.timer);
                        press.current = null;
                        onStart();
                        return;
                    }
                    finish("send");
                }}
                onPointerCancel={() => {
                    const current = press.current;
                    if (current?.timer) clearTimeout(current.timer);
                    if (current?.heldAt) finish("cancel");
                    else press.current = null;
                }}
                onClick={(event) => {
                    // The keyboard's press: pointer presses were handled above.
                    if (event.detail === 0 && !recording) onStart();
                }}
                onContextMenu={(event) => event.preventDefault()}
                className={cn(
                    "touch-none select-none rounded rounded-e-none p-1.5 pe-1 transition-colors [-webkit-touch-callout:none] disabled:opacity-50",
                    holding
                        ? "bg-danger-soft text-danger"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
            >
                <Mic className="size-4 shrink-0" />
            </button>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        disabled={disabled}
                        aria-label={t("composer.microphoneSettings")}
                        title={t("composer.microphoneSettings")}
                        className="rounded rounded-s-none py-1.5 ps-0.5 pe-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                        <ChevronDown className="size-3 shrink-0" />
                    </button>
                </DropdownMenuTrigger>
                {/* Upward: the composer is at the bottom of the screen. The
                    settings are drawn rather than listed as menu items, because
                    one of them is a slider and a menu that closes on every press
                    is no place for one. */}
                <DropdownMenuContent align="start" side="top" className="w-72">
                    <MicSettings className="p-1" />
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    );
}

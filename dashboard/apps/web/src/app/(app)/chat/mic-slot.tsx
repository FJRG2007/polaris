"use client";

/**
 * The mic at the end of an empty composer: tap to dictate, hold for a voice
 * message.
 *
 * Tap and hold are told apart by time (`HOLD_MS`). A hold starts a voice
 * message the way every phone messenger does: release sends it, sliding left
 * throws it away, sliding up keeps it recording without the finger - after which
 * the recording panel's own Send and bin finish it. Where there is no engine to
 * dictate with, a tap records too, so the button is never dead.
 *
 * Everything about the microphone - which one, how much noise is removed, how
 * loud, and which engine dictates - is in its menu: the chevron or a right-click
 * on a computer, a sheet on a phone (reached from the "+" sheet and from the
 * dictation strip, since a hold on a phone is the voice message).
 */

import { MicSettings } from "./mic-settings";
import { ChevronDown, Mic, Square } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    cn,
    Dialog,
    DialogContent,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Switch
} from "@polaris/ui";
import {
    dictationHintSeen,
    holdAction,
    HOLD_MS,
    markDictationHintSeen,
    SHORTEST_VOICE_MS,
    slideOutcome,
    tapAction,
    type DictationEngine
} from "./dictation-logic";

export function MicSlot({
    disabled,
    engine,
    voiceAllowed,
    dictating,
    level,
    handheld,
    shortcut,
    menuOpen,
    onMenuOpenChange,
    onDictate,
    onVoiceStart,
    onVoiceStop,
    onVoiceCancel,
    privateChoice
}: {
    disabled: boolean;
    engine: DictationEngine | null;
    /** A voice message may be sent here. */
    voiceAllowed: boolean;
    dictating: boolean;
    /** 0 to 100, drawn as the red ring while dictating. */
    level: number;
    /** A coarse pointer: hold for a voice message, the menu as a sheet. */
    handheld: boolean;
    /** The dictation key as this keyboard prints it, or "". */
    shortcut: string;
    menuOpen: boolean;
    onMenuOpenChange: (open: boolean) => void;
    /** Start or stop dictation. */
    onDictate: () => void;
    onVoiceStart: () => void;
    onVoiceStop: () => void;
    onVoiceCancel: () => void;
    /** The "Private dictation" switch, where both engines exist. */
    privateChoice: { on: boolean; onChange: (on: boolean) => void } | null;
}) {
    const t = useTranslations("chat");
    const [hint, setHint] = useState(false);
    const [holding, setHolding] = useState(false);
    const press = useRef<{
        x: number;
        y: number;
        timer: ReturnType<typeof setTimeout> | null;
        /** A voice message started by this press, and when. */
        voiceAt: number;
        locked: boolean;
        done: boolean;
    } | null>(null);

    // The one-time hint, only where a tap and a hold do different things.
    useEffect(() => {
        if (engine && voiceAllowed && !dictationHintSeen()) setHint(true);
    }, [engine, voiceAllowed]);
    const seen = () => {
        if (!hint) return;
        setHint(false);
        markDictationHintSeen();
    };

    useEffect(
        () => () => {
            if (press.current?.timer) clearTimeout(press.current.timer);
        },
        []
    );

    const tap = () => {
        seen();
        if (dictating) return onDictate();
        const action = tapAction({ engine, voiceAllowed });
        if (action === "dictate") onDictate();
        else if (action === "voice") onVoiceStart();
    };

    const finishHold = (outcome: "send" | "cancel") => {
        const current = press.current;
        press.current = null;
        setHolding(false);
        if (!current || current.done) return;
        current.done = true;
        if (!current.voiceAt) return;
        // A slip of the finger is not a message.
        if (outcome === "cancel" || Date.now() - current.voiceAt < SHORTEST_VOICE_MS)
            onVoiceCancel();
        else onVoiceStop();
    };

    const label = dictating
        ? t("dictation.stop")
        : engine
          ? shortcut
              ? t("dictation.startWithKey", { key: shortcut })
              : t("dictation.start")
          : t("composer.recordAVoiceMessage");

    const button = (
        <button
            type="button"
            disabled={disabled}
            aria-label={label}
            title={label}
            aria-pressed={engine ? dictating : undefined}
            onPointerDown={(event) => {
                if (event.button !== 0 || disabled) return;
                event.currentTarget.setPointerCapture?.(event.pointerId);
                const current = {
                    x: event.clientX,
                    y: event.clientY,
                    timer: null as ReturnType<typeof setTimeout> | null,
                    voiceAt: 0,
                    locked: false,
                    done: false
                };
                press.current = current;
                if (dictating) return;
                current.timer = setTimeout(() => {
                    current.timer = null;
                    if (press.current !== current) return;
                    seen();
                    const action = holdAction({ engine, voiceAllowed });
                    if (action !== "voice") return;
                    setHolding(true);
                    current.voiceAt = Date.now();
                    onVoiceStart();
                }, HOLD_MS);
            }}
            onPointerMove={(event) => {
                const current = press.current;
                if (!current?.voiceAt || current.locked) return;
                const outcome = slideOutcome(event.clientX - current.x, event.clientY - current.y);
                if (outcome === "cancel") finishHold("cancel");
                else if (outcome === "lock") {
                    // Recording on, finger free: the panel's buttons finish it.
                    current.locked = true;
                    current.done = true;
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
                    tap();
                    return;
                }
                if (current.voiceAt) return finishHold("send");
                // Held where a hold means a tap.
                press.current = null;
                tap();
            }}
            onPointerCancel={() => {
                const current = press.current;
                if (current?.timer) clearTimeout(current.timer);
                if (current?.voiceAt) finishHold("cancel");
                else press.current = null;
            }}
            onClick={(event) => {
                // The keyboard's press: pointer presses were handled above.
                if (event.detail === 0) tap();
            }}
            onContextMenu={(event) => {
                // A long press on a phone is the voice message, not the
                // browser's own menu; a right-click is the mic menu.
                event.preventDefault();
                if (!handheld) onMenuOpenChange(true);
            }}
            className={cn(
                "relative touch-none select-none rounded p-1.5 transition-colors [-webkit-touch-callout:none] disabled:opacity-50",
                dictating
                    ? "bg-danger-soft text-danger"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                !handheld && "rounded-r-none pr-1"
            )}
        >
            {dictating ? (
                <>
                    {/* The ring grows with what is heard, so it is plain the
                        mic is live. */}
                    <span
                        aria-hidden
                        className="pointer-events-none absolute inset-0 rounded ring-2 ring-danger transition-opacity"
                        style={{ opacity: 0.25 + Math.min(1, level / 60) * 0.75 }}
                    />
                    <Square className="size-4 fill-current" />
                </>
            ) : (
                <Mic className="size-4" />
            )}
        </button>
    );

    const body = (
        <MicMenuBody
            voiceAllowed={voiceAllowed}
            privateChoice={privateChoice}
            onVoice={() => {
                onMenuOpenChange(false);
                onVoiceStart();
            }}
            item={!handheld}
        />
    );

    return (
        <span className="relative flex items-center">
            {hint && (
                <span
                    role="status"
                    className="absolute bottom-full right-0 z-10 mb-2 flex w-max max-w-[min(16rem,calc(100vw-2rem))] items-start gap-2 rounded-md border border-border-strong bg-elevated px-2.5 py-1.5 text-xs shadow-modal"
                >
                    <span className="min-w-0">
                        {handheld ? t("dictation.hintPhone") : t("dictation.hintComputer")}
                    </span>
                    <button
                        type="button"
                        onClick={seen}
                        className="shrink-0 font-medium text-primary hover:underline"
                    >
                        {t("dictation.gotIt")}
                    </button>
                </span>
            )}
            {holding && (
                <span
                    role="status"
                    className="absolute bottom-full right-0 z-10 mb-2 w-max max-w-[calc(100vw-2rem)] rounded-md bg-elevated px-2.5 py-1.5 text-xs shadow-modal"
                >
                    {t("dictation.slideHint")}
                </span>
            )}
            {button}
            {handheld ? (
                <Dialog open={menuOpen} onOpenChange={onMenuOpenChange}>
                    <DialogContent
                        aria-describedby={undefined}
                        className="bottom-0 left-0 top-auto w-full max-w-full translate-x-0 translate-y-0 rounded-b-none pb-[max(1rem,env(safe-area-inset-bottom))] data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8"
                    >
                        <DialogTitle className="pb-2">
                            {t("composer.microphoneSettings")}
                        </DialogTitle>
                        {body}
                    </DialogContent>
                </Dialog>
            ) : (
                <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            disabled={disabled}
                            aria-label={t("composer.microphoneSettings")}
                            title={t("composer.microphoneSettings")}
                            className="rounded rounded-l-none py-1.5 pl-0.5 pr-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                            <ChevronDown className="size-3" />
                        </button>
                    </DropdownMenuTrigger>
                    {/* Upward and to the end: the box is at the bottom of the
                        screen and the mic at the end of it. */}
                    <DropdownMenuContent align="end" side="top" className="w-72">
                        {body}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </span>
    );
}

/**
 * What is behind the mic: a voice message on demand, the engine switch, and the
 * microphone's own settings. A menu item on a computer; a plain button in the
 * phone's sheet, which is not a menu.
 */
function MicMenuBody({
    voiceAllowed,
    privateChoice,
    onVoice,
    item
}: {
    voiceAllowed: boolean;
    privateChoice: { on: boolean; onChange: (on: boolean) => void } | null;
    onVoice: () => void;
    item: boolean;
}) {
    const t = useTranslations("chat");
    let voice: ReactNode = null;
    if (voiceAllowed) {
        voice = item ? (
            <DropdownMenuItem onSelect={onVoice}>
                <Mic />
                {t("dictation.voiceMessage")}
            </DropdownMenuItem>
        ) : (
            <button
                type="button"
                onClick={onVoice}
                className="flex min-h-12 w-full items-center gap-3 rounded-md px-1 text-left text-sm hover:bg-muted"
            >
                <Mic className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{t("dictation.voiceMessage")}</span>
            </button>
        );
    }
    return (
        <div className="flex flex-col gap-2">
            {voice}
            {privateChoice && (
                <label className="flex items-start justify-between gap-3 px-2 py-1 text-xs">
                    <span className="flex min-w-0 flex-col">
                        <span className="font-medium text-foreground">
                            {t("dictation.private")}
                        </span>
                        <span className="text-muted-foreground">{t("dictation.privateHelp")}</span>
                    </span>
                    <Switch
                        checked={privateChoice.on}
                        onChange={privateChoice.onChange}
                        aria-label={t("dictation.private")}
                    />
                </label>
            )}
            <MicSettings className="p-1" />
        </div>
    );
}

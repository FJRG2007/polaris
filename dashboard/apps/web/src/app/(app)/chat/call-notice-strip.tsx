"use client";

/**
 * Everything the call has to say about itself, as one line.
 *
 * The notices used to be a stack of banners, each drawn by whoever measured it,
 * and when the call server went away four of them arrived at once and took the
 * height the pictures and the controls needed - three of them only that one
 * fault seen from the microphone's side. Calling software that people use every
 * day settled on the same answer for this: the connection is one compact line
 * with a coloured signal, the detail is behind a press, and what is wrong with
 * your microphone is marked on the microphone.
 *
 * So the notices are collected here, weighed by `call-notices`, and the most
 * serious is the one line drawn. The others wait behind a count that opens them
 * in place, and what one of them only follows from is kept under it rather than
 * thrown away - every sentence that used to be drawn can still be read.
 */

import { cn } from "@polaris/ui";
import type { CallState } from "./call-state";
import { useQuietMic } from "./quiet-mic-notice";
import { useNoAudioWarning } from "./no-audio-notice";
import { useState, type ComponentType } from "react";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useNetworkState } from "@enigmax/primitives/react/network";
import { SERVER_LOST, type CallAudioLine, type CallAudioReport } from "./call-diagnosis";
import {
    arbitrateNotices,
    type CallNotice,
    type NoticeCause,
    type NoticeOrder
} from "./call-notices";
import {
    AlertTriangle,
    Info,
    MicOff,
    Monitor,
    Volume1,
    VolumeX,
    Wifi,
    WifiOff,
    X,
    type LucideProps
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";

/** One notice, with everything it needs to be drawn. */
export interface ShownNotice extends CallNotice {
    /** The few words the line holds. */
    readonly short: string;
    /** The whole sentence, read in its details. */
    readonly full: string;
    /** What to do about it, where there is more to say than the sentence. */
    readonly fix?: string;
    /** The checks a diagnosis was reached from. */
    readonly lines?: readonly CallAudioLine[];
    readonly icon: ComponentType<LucideProps>;
    /** The one thing that fixes it from here, drawn beside the words. */
    readonly action?: { readonly label: string; readonly run: () => void };
    readonly dismiss?: () => void;
}

type ChatT = NamespaceTranslator<"chat">;

/** A control's reach, grown past what it draws so a finger finds it without the
 *  line getting any taller. */
const REACH = "relative after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']";

/** What the diagnosis said, as a notice the strip can weigh. */
function diagnosisNotice(audio: CallAudioReport, t: ChatT, rejoin: () => void): ShownNotice | null {
    if (audio.ok || !audio.headline) return null;
    const said = {
        id: "diagnosis",
        full: audio.headline,
        fix: audio.fix || undefined,
        lines: audio.lines
    };
    if (audio.link === "lost") {
        return {
            ...said,
            severity: "error",
            cause: "server",
            short: t("callNotices.short.serverLost"),
            icon: WifiOff,
            action: { label: t("callNotices.rejoin"), run: rejoin }
        };
    }
    if (audio.link === "reconnecting") {
        return {
            ...said,
            severity: "warning",
            cause: "server",
            short: t("callNotices.short.reconnecting"),
            icon: Wifi
        };
    }
    if (audio.blame === "theirs") {
        return {
            ...said,
            severity: "info",
            cause: "far-end",
            short: t("callNotices.short.theirs"),
            icon: Info
        };
    }
    const mic = (short: string, cause: NoticeCause = "mic-fault"): ShownNotice => ({
        ...said,
        severity: cause === "mic-fault" ? "error" : "warning",
        cause,
        short,
        icon: MicOff
    });
    if (audio.mic === "no-device") return mic(t("callNotices.short.noMicrophone"));
    if (audio.mic === "dead") return mic(t("callNotices.short.micStopped"));
    if (audio.mic === "unpublished") return mic(t("callNotices.short.micNotSent"));
    if (audio.mic === "no-input") return mic(t("callNotices.short.micSilent"), "mic-silent");
    if (audio.farEnd) {
        return {
            ...said,
            severity: "warning",
            cause: "far-end",
            short: t("callNotices.short.othersSilent"),
            icon: VolumeX
        };
    }
    return {
        ...said,
        severity: "warning",
        cause: "sound",
        short: t("callNotices.short.turnedDown"),
        icon: VolumeX
    };
}

/**
 * Every notice the call has right now, weighed.
 *
 * Called once by the room, which draws the strip from it and marks the
 * microphone button with the notice that belongs there.
 */
export function useCallNotices(call: CallState): NoticeOrder<ShownNotice> {
    const t = useTranslations("chat");
    const tc = useTranslations("components");
    const { online, slow } = useNetworkState();
    // Watching what is published rather than the device behind it: with a noise
    // filter running they are two different tracks, and a graph that stopped
    // producing anything leaves the device reading perfectly while the call
    // carries silence. See `no-audio-notice`.
    const noAudio = useNoAudioWarning({
        track: call.outgoing,
        device: call.localStream?.getAudioTracks()[0] ?? null,
        micOn: call.micOn
    });
    const quiet = useQuietMic(call.micOn);

    const { error, audio, shareStill, rejoin } = call;
    const found: ShownNotice[] = [];
    if (error === SERVER_LOST) {
        found.push({
            id: "server",
            severity: "error",
            cause: "server",
            short: t("callNotices.short.serverLost"),
            full: t("callNotices.serverLost"),
            icon: WifiOff,
            action: { label: t("callNotices.rejoin"), run: rejoin }
        });
    } else if (error) {
        // Said by the call in a sentence of its own - a camera refused, a
        // picture made smaller - and drawn as it is.
        found.push({
            id: "error",
            severity: "error",
            cause: "other",
            short: error,
            full: error,
            icon: AlertTriangle
        });
    }
    const diagnosis = diagnosisNotice(audio, t, rejoin);
    if (diagnosis) found.push(diagnosis);
    if (online && slow) {
        found.push({
            id: "slow",
            severity: "warning",
            cause: "line",
            short: t("callNotices.short.slowLine"),
            full: tc("network.slowCall"),
            icon: Wifi
        });
    }
    if (noAudio.warning) {
        found.push({
            id: "no-audio",
            severity: "warning",
            cause: "mic-silent",
            short: t("callNotices.short.micSilent"),
            full: t("noAudio.yourMicrophoneHasNotPicked"),
            icon: MicOff,
            dismiss: noAudio.dismiss
        });
    }
    if (quiet.quiet) {
        found.push({
            id: "quiet-mic",
            severity: "warning",
            cause: "mic-quiet",
            short: t("callNotices.short.quietMic"),
            full: quiet.atMax
                ? t("quietMic.atMax", { db: quiet.db })
                : t("quietMic.quiet", { db: quiet.db }),
            icon: Volume1,
            action: quiet.atMax ? undefined : { label: t("quietMic.turnUp"), run: quiet.turnUp },
            dismiss: quiet.dismiss
        });
    }
    if (shareStill) {
        found.push({
            id: "share-still",
            severity: "info",
            cause: "share",
            short: t("callNotices.short.shareStill"),
            full: t("callRoom.whatYouAreSharingHas"),
            icon: Monitor
        });
    }
    return arbitrateNotices(found);
}

/** How a notice of each weight is coloured. Status tokens only - see
 *  `test/design/status-tokens`. */
const TONE: Readonly<Record<CallNotice["severity"], string>> = {
    // i18n-ignore: class names
    error: "border-danger-edge bg-danger-soft text-danger-ink",
    warning: "border-warning-edge bg-warning-soft text-warning-ink",
    info: "border-border bg-muted text-foreground"
};

/** One notice as one line: its signal, its words, and what can be done. */
function NoticeRow({
    notice,
    role,
    children
}: {
    notice: ShownNotice;
    role?: "alert" | "status";
    children?: React.ReactNode;
}) {
    const t = useTranslations("chat");
    const Icon = notice.icon;
    return (
        <div
            role={role}
            className={cn(
                "flex min-w-0 shrink-0 items-center gap-2 rounded-md border px-2.5 py-1 text-xs",
                TONE[notice.severity]
            )}
        >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            {/* The few words, and the whole sentence for whoever points at
                them; the details below hold it too, for a touch screen. */}
            <span className="min-w-0 flex-1 truncate font-medium" title={notice.full}>
                {notice.short}
                <span className="sr-only">. {notice.full}</span>
            </span>
            {notice.action && (
                <button
                    type="button"
                    onClick={notice.action.run}
                    className={cn(
                        REACH,
                        "shrink-0 rounded px-1.5 py-0.5 font-medium underline decoration-dotted underline-offset-2 hover:no-underline"
                    )}
                >
                    {notice.action.label}
                </button>
            )}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={t("callNotices.details")}
                        title={t("callNotices.details")}
                        className={cn(
                            REACH,
                            "-my-0.5 shrink-0 rounded p-1 opacity-80 transition-opacity hover:opacity-100"
                        )}
                    >
                        <Info className="size-3.5" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
                    <div className="flex flex-col gap-1.5 px-2 py-1.5 text-xs">
                        <p className="font-medium text-foreground">{notice.full}</p>
                        {notice.fix && <p className="text-muted-foreground">{notice.fix}</p>}
                    </div>
                    {notice.lines && notice.lines.length > 0 && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>{t("diagnosis.whatWasChecked")}</DropdownMenuLabel>
                            <dl className="flex flex-col gap-1 px-2 pb-1.5 text-xs">
                                {notice.lines.map((line) => (
                                    <div key={line.label} className="flex items-baseline gap-3">
                                        <dt className="w-32 shrink-0 text-muted-foreground">
                                            {line.label}
                                        </dt>
                                        <dd
                                            className={cn(
                                                "min-w-0 flex-1",
                                                line.state === "bad" && "text-warning",
                                                line.state === "good" && "text-success",
                                                line.state === "idle" && "text-muted-foreground"
                                            )}
                                        >
                                            {line.value}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            {notice.dismiss && (
                <button
                    type="button"
                    onClick={notice.dismiss}
                    aria-label={t("noAudio.dismiss")}
                    title={t("noAudio.dismiss")}
                    className={cn(
                        REACH,
                        "-my-0.5 shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100"
                    )}
                >
                    <X className="size-3.5" />
                </button>
            )}
            {children}
        </div>
    );
}

/**
 * The line, and the notices behind it.
 *
 * One row tall while it is closed, which is what keeps the pictures and the
 * controls where they are on a short window or a phone. Opened, the rest are
 * drawn under it in a list of bounded height that scrolls.
 */
export function CallNoticeStrip({ order }: { order: NoticeOrder<ShownNotice> }) {
    const t = useTranslations("chat");
    const [open, setOpen] = useState(false);
    const { top, rest, consequences } = order;
    if (!top) return null;
    const hidden = rest.length + consequences.length;

    return (
        <section
            aria-label={t("callNotices.region")}
            className="flex min-h-0 shrink-0 flex-col gap-1"
        >
            <NoticeRow notice={top} role={top.severity === "error" ? "alert" : "status"}>
                {hidden > 0 && (
                    <button
                        type="button"
                        onClick={() => setOpen((was) => !was)}
                        aria-expanded={open}
                        aria-label={
                            open
                                ? t("callNotices.showLess")
                                : t("callNotices.showMore", { count: hidden })
                        }
                        title={
                            open
                                ? t("callNotices.showLess")
                                : t("callNotices.showMore", { count: hidden })
                        }
                        className={cn(
                            REACH,
                            "shrink-0 rounded px-1.5 py-0.5 font-medium tabular-nums hover:bg-background/40"
                        )}
                    >
                        {t("callNotices.more", { count: hidden })}
                    </button>
                )}
            </NoticeRow>
            {/* What waits behind the line is still announced, the way each
                banner was: politely, and without opening anything. */}
            {!open && rest.length > 0 && (
                <p role="status" className="sr-only">
                    {rest.map((notice) => notice.short).join(". ")}
                </p>
            )}
            {open && hidden > 0 && (
                <div className="flex max-h-28 min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain">
                    {rest.map((notice) => (
                        <NoticeRow key={notice.id} notice={notice} role="status" />
                    ))}
                    {consequences.length > 0 && (
                        <>
                            <p className="shrink-0 px-1 text-[11px] text-muted-foreground">
                                {t("callNotices.followsFrom")}
                            </p>
                            {consequences.map((notice) => (
                                <div key={notice.id} className="opacity-75">
                                    <NoticeRow notice={notice} />
                                </div>
                            ))}
                        </>
                    )}
                </div>
            )}
        </section>
    );
}

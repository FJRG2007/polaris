"use client";

/**
 * Reporting a problem with the screen being shared. It goes to this Polaris
 * instance's own Telemetry project, where its administrators read Polaris'
 * faults, with the stream's frame rate, resolution and sound beside it.
 */

import { useState } from "react";
import type { CallState } from "./use-call";
import { desktopBridge } from "@/lib/desktop-bridge";
import { modeOf, useStreamPrefs } from "./stream-shape";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { STREAM_PROBLEMS, type StreamProblem } from "./stream-report-kinds";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Textarea,
    useToast
} from "@polaris/ui";

const MAX_NOTE = 500;

export function StreamReportDialog({
    call,
    open,
    onOpenChange
}: {
    call: CallState;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("chat");
    const toast = useToast();
    const prefs = useStreamPrefs();
    const [problem, setProblem] = useState<StreamProblem | null>(null);
    const [note, setNote] = useState("");
    const [sending, setSending] = useState(false);

    const close = (next: boolean) => {
        if (!next) {
            setProblem(null);
            setNote("");
        }
        onOpenChange(next);
    };

    const send = async () => {
        if (!problem || sending) return;
        setSending(true);
        const shape = prefs.shape;
        const ok = await fetch("/api/chat/stream-report", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                problem,
                note: note.trim(),
                settings: {
                    mode: shape ? modeOf(shape) : "auto",
                    frameRate: shape?.frameRate ?? null,
                    resolution: shape ? String(shape.resolution) : null,
                    sound: call.shareAudio.has && call.shareAudio.on,
                    platform: desktopBridge() ? "desktop" : "browser"
                }
            })
        })
            .then((response) => response.ok)
            .catch(() => false);
        setSending(false);
        if (!ok) {
            toast.show({ key: "stream-report", title: t("streamReport.failed") });
            return;
        }
        toast.show({ key: "stream-report", title: t("streamReport.sent") });
        close(false);
    };

    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("streamReport.title")}</DialogTitle>
                    <DialogDescription>{t("streamReport.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <div
                        role="radiogroup"
                        aria-label={t("streamReport.title")}
                        className="flex flex-col gap-1"
                    >
                        {STREAM_PROBLEMS.map((kind) => (
                            <button
                                key={kind}
                                type="button"
                                role="radio"
                                aria-checked={problem === kind}
                                onClick={() => setProblem(kind)}
                                className={cn(
                                    "flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-start text-sm transition-colors",
                                    problem === kind
                                        ? "border-primary bg-primary/10"
                                        : "border-border hover:bg-card-hover"
                                )}
                            >
                                <span
                                    aria-hidden
                                    className={cn(
                                        "size-3.5 shrink-0 rounded-full border",
                                        problem === kind
                                            ? "border-primary bg-primary shadow-[inset_0_0_0_2px_var(--color-background,white)]"
                                            : "border-border-strong"
                                    )}
                                />
                                <span className="min-w-0 truncate">
                                    {t(`streamReport.problems.${kind}`)}
                                </span>
                            </button>
                        ))}
                    </div>
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span>{t("streamReport.note")}</span>
                        <Textarea
                            value={note}
                            maxLength={MAX_NOTE}
                            rows={3}
                            onChange={(event) => setNote(event.target.value)}
                        />
                    </label>
                </div>
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => close(false)}>
                        {t("sharePicker.cancel")}
                    </Button>
                    <Button
                        type="button"
                        aria-disabled={!problem || sending}
                        title={problem ? undefined : t("streamReport.pickFirst")}
                        onClick={() => void send()}
                    >
                        {t("streamReport.send")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

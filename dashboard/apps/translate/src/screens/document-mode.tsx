"use client";

/**
 * A document translated whole: chosen or dropped, read in the browser
 * (`documents.ts`), its paragraphs translated a batch at a time with the
 * progress shown, and handed back in its own format to download.
 */

import type { Translate } from "./run";
import { ServerEngineError } from "./server-engine";
import { useTranslateT } from "./i18n";
import { FileText, FileUp } from "lucide-react";
import { Button, cn } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { DOCUMENT_MAX_BYTES } from "../model/media";
import { DocumentError, openDocument, translatedName, type DocumentFormat } from "./documents";
import { hostUi } from "@polaris/app-host/client";

const { useChooseFiles } = hostUi.filePicker;

/** Paragraphs sent at once: small enough for the progress to move. */
const BATCH = 40;
/** Times one batch waits out the rate limit before the document gives up. */
const RATE_RETRIES = 3;
/** The wait when the server did not say how long. */
const RATE_WAIT_SECONDS = 60;
/** How much of the translation the preview shows. */
const PREVIEW_CHARS = 3000;

/** Resolves after `seconds`, or rejects as soon as `signal` aborts. */
function wait(seconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(resolve, seconds * 1000);
        signal.addEventListener(
            "abort",
            () => {
                window.clearTimeout(timer);
                reject(signal.reason);
            },
            { once: true }
        );
    });
}

/**
 * One batch through `translate`, waiting out the per-person rate limit and
 * trying again, so a long document never loses what it already translated.
 */
async function translateBatch(
    translate: Translate,
    texts: string[],
    signal: AbortSignal
): Promise<string[]> {
    for (let attempt = 0; ; attempt++) {
        try {
            return (await translate(texts, signal)).texts;
        } catch (caught) {
            const limited = caught instanceof ServerEngineError && caught.code === "rate";
            if (!limited || attempt >= RATE_RETRIES || signal.aborted) throw caught;
            await wait(caught.retryAfter ?? RATE_WAIT_SECONDS, signal);
        }
    }
}

type Phase =
    | { kind: "idle" }
    | { kind: "reading" }
    | { kind: "translating"; done: number; total: number }
    | { kind: "done"; url: string; name: string; preview: string; format: DocumentFormat };

export function DocumentMode({
    translate,
    charLimit,
    to
}: {
    translate: Translate;
    charLimit: number | null;
    to: string;
}) {
    const t = useTranslateT();
    const [chooseFiles, chooser] = useChooseFiles();
    const running = useRef<AbortController | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });
    const [error, setError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);

    useEffect(() => () => running.current?.abort(), []);
    useEffect(
        () => () => {
            if (phase.kind === "done") URL.revokeObjectURL(phase.url);
        },
        [phase]
    );

    const open = async (file: File) => {
        running.current?.abort();
        const controller = new AbortController();
        running.current = controller;
        setError(null);
        if (file.size > DOCUMENT_MAX_BYTES) return setError(t("errors.fileTooLarge"));
        setPhase({ kind: "reading" });
        try {
            const job = await openDocument(new Uint8Array(await file.arrayBuffer()));
            const total = job.segments.reduce((sum, text) => sum + text.length, 0);
            if (charLimit !== null && total > charLimit) {
                throw new Error(t("errors.overLimit", { limit: charLimit }));
            }
            const out: string[] = [];
            setPhase({ kind: "translating", done: 0, total: job.segments.length });
            for (let at = 0; at < job.segments.length; at += BATCH) {
                const texts = await translateBatch(
                    translate,
                    job.segments.slice(at, at + BATCH),
                    controller.signal
                );
                if (controller.signal.aborted) return;
                out.push(...texts);
                setPhase({ kind: "translating", done: out.length, total: job.segments.length });
            }
            const blob = await job.build(out);
            const original = /\.[^./\\]+$/.exec(file.name)?.[0] ?? ".txt";
            const extension = job.format === "text" ? original : job.extension;
            setPhase({
                kind: "done",
                url: URL.createObjectURL(blob),
                name: translatedName(file.name, to, extension),
                preview: out.join("\n\n").slice(0, PREVIEW_CHARS),
                format: job.format
            });
        } catch (caught) {
            if (controller.signal.aborted) return;
            setPhase({ kind: "idle" });
            setError(
                caught instanceof DocumentError
                    ? caught.code === "type"
                        ? t("errors.documentType")
                        : t("errors.documentFailed")
                    : (caught as Error).message
            );
        }
    };

    const cancel = () => {
        running.current?.abort();
        setPhase({ kind: "idle" });
    };

    const pick = () =>
        void chooseFiles({
            accept: ".docx,.pptx,.xlsx,.pdf,.txt,.md,.csv,.srt,.vtt",
            onFailed: setError
        }).then(([file]) => {
            if (file) void open(file);
        });

    return (
        <div className="flex min-w-0 flex-col gap-3">
            {chooser}
            {phase.kind === "idle" ? (
                <button
                    type="button"
                    onClick={pick}
                    onDragOver={(event) => {
                        event.preventDefault();
                        setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        const file = event.dataTransfer.files[0];
                        if (file) void open(file);
                    }}
                    className={cn(
                        "flex min-h-48 w-full min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center",
                        dragging && "bg-muted/40"
                    )}
                >
                    <FileUp className="size-6 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="text-sm font-medium">{t("document.choose")}</span>
                    <span className="text-xs text-muted-foreground">{t("document.hint")}</span>
                </button>
            ) : phase.kind === "done" ? (
                <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                        <p
                            className="min-w-0 flex-1 truncate text-sm font-medium"
                            title={phase.name}
                        >
                            {t("document.ready", { name: phase.name })}
                        </p>
                        <Button asChild size="sm">
                            <a href={phase.url} download={phase.name}>
                                {t("document.download")}
                            </a>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setPhase({ kind: "idle" })}
                        >
                            {t("document.another")}
                        </Button>
                    </div>
                    {phase.format === "pdf" ? (
                        <p className="text-xs text-muted-foreground">{t("document.pdfNote")}</p>
                    ) : null}
                    <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                            {t("document.preview")}
                        </summary>
                        <p className="max-h-80 overflow-y-auto whitespace-pre-wrap pt-2 text-sm [overflow-wrap:anywhere]">
                            {phase.preview}
                        </p>
                    </details>
                </section>
            ) : (
                <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3">
                    <p className="text-sm" role="status">
                        {phase.kind === "reading"
                            ? t("document.reading")
                            : t("document.progress", { done: phase.done, total: phase.total })}
                    </p>
                    <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(
                            phase.kind === "translating" && phase.total > 0
                                ? (phase.done / phase.total) * 100
                                : 0
                        )}
                        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    >
                        <div
                            className="h-full rounded-full bg-primary transition-[width]"
                            style={{
                                width: `${phase.kind === "translating" && phase.total > 0 ? (phase.done / phase.total) * 100 : 0}%`
                            }}
                        />
                    </div>
                    <Button variant="outline" size="sm" className="self-end" onClick={cancel}>
                        {t("document.cancel")}
                    </Button>
                </section>
            )}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
    );
}

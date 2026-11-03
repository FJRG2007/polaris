"use client";

/**
 * A picture translated: pasted, dropped or chosen, its text read (the
 * browser's detector or the server's model) and the translation drawn over
 * each line where it was, or beside the picture. Both sides copy.
 */

import type { Translate } from "./run";
import { useTranslateT } from "./i18n";
import { ImageUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IMAGE_MAX_BYTES, sniffImage } from "../model/media";
import { Button, CopyButton, SegmentedControl, Skeleton, cn } from "@polaris/ui";
import { isRightToLeft } from "../model/languages";
import { TranslatedPicture } from "./translated-picture";
import {
    ReadsNotice,
    hasLocalReader,
    readImageText,
    type ImageLine,
    type Reads
} from "./reads";
import { hostUi } from "@polaris/app-host/client";

const { useChooseFiles } = hostUi.filePicker;

type View = "translated" | "original";

export function ImageMode({
    translate,
    reads,
    manager,
    to,
    file
}: {
    translate: Translate;
    reads: Reads;
    manager: boolean;
    /** The language translated into, for the direction the text is drawn in. */
    to: string;
    /** A file handed over by the box (dropped, pasted or chosen), opened on arrival. */
    file?: File | null;
}) {
    const t = useTranslateT();
    const [chooseFiles, chooser] = useChooseFiles();
    const picture = useRef<HTMLImageElement>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [lines, setLines] = useState<ImageLine[] | null>(null);
    const [translated, setTranslated] = useState<string[] | null>(null);
    const [reading, setReading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [view, setView] = useState<View>("translated");
    const [local, setLocal] = useState(false);
    const [dragging, setDragging] = useState(false);
    const ticket = useRef(0);

    useEffect(() => setLocal(hasLocalReader()), []);
    useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

    const canRead = reads.images || local;

    const open = async (file: Blob) => {
        setError(null);
        if (file.size > IMAGE_MAX_BYTES) return setError(t("errors.fileTooLarge"));
        const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        if (!sniffImage(head)) return setError(t("errors.imageType"));
        const mine = ++ticket.current;
        setUrl(URL.createObjectURL(file));
        setLines(null);
        setTranslated(null);
        setReading(true);
        try {
            const found = await readImageText(file, {
                server: reads.images,
                fallback: t("errors.readFailed")
            });
            if (mine !== ticket.current) return;
            setLines(found);
            setView("translated");
        } catch (caught) {
            if (mine === ticket.current) setError((caught as Error).message);
        } finally {
            if (mine === ticket.current) setReading(false);
        }
    };

    // The lines, translated again whenever the languages or the engine change.
    useEffect(() => {
        if (!lines || lines.length === 0) return;
        const controller = new AbortController();
        setTranslated(null);
        translate(
            lines.map((line) => line.text),
            controller.signal
        ).then(
            (answer) => {
                setTranslated(answer.texts);
                setError(null);
            },
            (caught: Error) => {
                if (!controller.signal.aborted) setError(caught.message);
            }
        );
        return () => controller.abort();
    }, [lines, translate]);

    // The box hands a picture over; a newer one replaces it.
    useEffect(() => {
        if (file) void open(file);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- open reads the latest state itself
    }, [file]);

    const clear = () => {
        ++ticket.current;
        setUrl(null);
        setLines(null);
        setTranslated(null);
        setError(null);
        setReading(false);
    };

    if (!canRead) return <ReadsNotice kind="images" manager={manager} />;

    const original = (lines ?? []).map((line) => line.text).join("\n");
    const translation = (translated ?? []).join("\n");
    const boxed = (lines ?? []).some((line) => line.box);
    const rightToLeft = isRightToLeft(to);
    const painted = boxed && translated !== null && view === "translated";

    const pick = () =>
        void chooseFiles({
            accept: "image/png,image/jpeg,image/webp,image/gif",
            onFailed: setError
        }).then(([file]) => {
            if (file) void open(file);
        });

    return (
        <div className="flex min-w-0 flex-col gap-3">
            {chooser}
            {!url ? (
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
                    <ImageUp className="size-6 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="text-sm font-medium">{t("image.drop")}</span>
                    <span className="text-xs text-muted-foreground">{t("image.hint")}</span>
                </button>
            ) : (
                <>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        {boxed ? (
                            <SegmentedControl
                                aria-label={t("image.view")}
                                value={view}
                                onValueChange={setView}
                                options={[
                                    { value: "translated", label: t("image.translated") },
                                    { value: "original", label: t("image.originalPicture") }
                                ]}
                            />
                        ) : null}
                        <Button variant="outline" size="sm" className="ml-auto" onClick={pick}>
                            {t("image.choose")}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={clear}
                            aria-label={t("image.clear")}
                            title={t("image.clear")}
                        >
                            <X className="size-4 shrink-0" aria-hidden />
                        </Button>
                    </div>
                    <div className="mx-auto w-fit max-w-full">
                        {painted ? (
                            <TranslatedPicture
                                url={url}
                                lines={lines!}
                                translated={translated!}
                                rightToLeft={rightToLeft}
                                label={t("image.altTranslated")}
                            />
                        ) : (
                            // eslint-disable-next-line @next/next/no-img-element -- a local object URL
                            <img
                                ref={picture}
                                src={url}
                                alt={t("image.alt")}
                                className="block max-h-[70vh] max-w-full rounded-lg border border-border"
                            />
                        )}
                    </div>
                    <section className="flex min-w-0 flex-col rounded-lg border border-border bg-muted/40">
                        <div
                            dir={rightToLeft ? "rtl" : "ltr"}
                            className="min-h-16 whitespace-pre-wrap px-2.5 py-2 text-base [overflow-wrap:anywhere]"
                        >
                            {translated ? (
                                translation
                            ) : reading || (lines && lines.length > 0) ? (
                                <div className="space-y-2">
                                    <Skeleton className="h-4 w-3/4" />
                                    <Skeleton className="h-4 w-2/3" />
                                </div>
                            ) : null}
                        </div>
                        <details className="border-t border-border px-2.5 py-1.5 text-sm">
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                                {t("image.original")}
                            </summary>
                            <p dir="auto" className="whitespace-pre-wrap py-1 [overflow-wrap:anywhere]">
                                {original}
                            </p>
                        </details>
                    </section>
                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                        <span
                            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                            role="status"
                        >
                            {error ? (
                                <span className="text-destructive">{error}</span>
                            ) : reading ? (
                                t("image.reading")
                            ) : lines && lines.length === 0 ? (
                                t("image.none")
                            ) : lines && !translated ? (
                                t("engine.translating")
                            ) : null}
                        </span>
                        <CopyButton value={original} label={t("image.copyOriginal")} />
                        <CopyButton value={translation} label={t("actions.copy")} />
                    </div>
                </>
            )}
            {!url && error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
    );
}

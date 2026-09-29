"use client";

/**
 * A picture, and everything worth doing to one.
 *
 * Converting, resizing and making it smaller are the same job seen from three
 * angles, and which of them somebody wants is usually decided by looking: they
 * want it under some size, or in a format that works where they are putting it,
 * and the way to find that out is to see what each choice costs. So this is one
 * screen with the picture on it and the weight of the result in front of them,
 * rather than three forms.
 *
 * The original is never touched and nothing is uploaded anywhere: the bytes go
 * to this Polaris, come back re-encoded, and are downloaded by the person who
 * sent them.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ImageUp, Loader2, MapPin } from "lucide-react";
import { Button, Input, Select, Switch, cn, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** What the file says about itself, as the server read it. */
interface Facts {
    format: string;
    width: number;
    height: number;
    bytes: number;
    hasAlpha: boolean;
    taken?: string;
    hasLocation: boolean;
}

interface Made {
    url: string;
    bytes: number;
    width: number;
    height: number;
}

/** Format names, the same in every language. */
const FORMATS = [
    { value: "webp", label: "WebP" }, // i18n-ignore
    { value: "jpeg", label: "JPEG" }, // i18n-ignore
    { value: "png", label: "PNG" }, // i18n-ignore
    { value: "avif", label: "AVIF" } // i18n-ignore
];

/** Bytes as somebody would say them. */
function weigh(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImagesView() {
    const toast = useToast();
    const t = useTranslations("tools");
    const [file, setFile] = useState<File | null>(null);
    const [facts, setFacts] = useState<Facts | null>(null);
    const [made, setMade] = useState<Made | null>(null);
    const [working, setWorking] = useState(false);

    const [format, setFormat] = useState("webp");
    const [quality, setQuality] = useState(80);
    const [longest, setLongest] = useState("");
    const [keepMetadata, setKeepMetadata] = useState(false);

    const pickerRef = useRef<HTMLInputElement | null>(null);
    // The object URL of the result, revoked when it is replaced: a slider that
    // re-encodes on every move would otherwise leak one image per move.
    const madeUrl = useRef<string | null>(null);

    const take = useCallback(
        async (chosen: File) => {
            setFile(chosen);
            setFacts(null);
            setMade(null);
            try {
                const answer = await fetch("/api/tools/image?op=facts", {
                    method: "POST",
                    body: chosen
                });
                if (!answer.ok) {
                    // The server says which: too large, or not a picture at all.
                    const said = (await answer.json().catch(() => null)) as { error?: unknown } | null;
                    throw new Error(typeof said?.error === "string" ? said.error : "");
                }
                setFacts((await answer.json()) as Facts);
            } catch (caught) {
                setFile(null);
                const message = caught instanceof Error ? caught.message : "";
                toast.show({ title: message || t("images.notAPicture") });
            }
        },
        [toast, t]
    );

    // Re-encoded as the controls move, after a beat. Every move is a real
    // encode on the server, and a slider dragged across its range would
    // otherwise be fifty of them.
    useEffect(() => {
        if (!file || !facts) return;
        // Owned by the effect, not by the timer callback: a return value from
        // inside `setTimeout` is thrown away, so a flag flipped there is a flag
        // that is never false. It is the cleanup below that has to flip it -
        // otherwise a slow encode overwrites the newer one that superseded it,
        // and one that lands after the screen is gone sets state and leaks the
        // object URL it made.
        let alive = true;
        const timer = setTimeout(() => {
            setWorking(true);
            void (async () => {
                try {
                    const query = new URLSearchParams({
                        format,
                        q: String(quality),
                        meta: keepMetadata ? "1" : "0"
                    });
                    if (longest) query.set("max", longest);
                    const answer = await fetch(`/api/tools/image?${query.toString()}`, {
                        method: "POST",
                        body: file
                    });
                    if (!answer.ok) throw new Error("failed");
                    const blob = await answer.blob();
                    if (!alive) return;
                    if (madeUrl.current) URL.revokeObjectURL(madeUrl.current);
                    madeUrl.current = URL.createObjectURL(blob);
                    setMade({
                        url: madeUrl.current,
                        bytes: blob.size,
                        width: Number(answer.headers.get("X-Image-Width")) || 0,
                        height: Number(answer.headers.get("X-Image-Height")) || 0
                    });
                } catch {
                    if (alive) toast.show({ title: t("images.convertFailed") });
                } finally {
                    if (alive) setWorking(false);
                }
            })();
        }, 250);
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [file, facts, format, quality, longest, keepMetadata, toast, t]);

    useEffect(
        () => () => {
            if (madeUrl.current) URL.revokeObjectURL(madeUrl.current);
        },
        []
    );

    const saved = facts && made ? 1 - made.bytes / facts.bytes : 0;

    return (
        <div className="flex flex-col gap-4">
            <input
                ref={pickerRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    if (chosen) void take(chosen);
                    event.target.value = "";
                }}
            />

            {!file ? (
                <button
                    type="button"
                    onClick={() => pickerRef.current?.click()}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                        event.preventDefault();
                        const dropped = event.dataTransfer.files?.[0];
                        if (dropped) void take(dropped);
                    }}
                    className="flex min-h-56 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-foreground-subtle transition-colors hover:border-primary hover:text-foreground"
                >
                    <ImageUp className="size-6 shrink-0" aria-hidden />
                    {t("images.drop")}
                </button>
            ) : (
                <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
                    <div className="flex min-w-0 flex-col gap-3">
                        <div className="relative flex min-h-56 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface/40 p-2">
                            {made ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={made.url}
                                    alt={t("images.converted")}
                                    className="max-h-[55vh] max-w-full object-contain"
                                />
                            ) : (
                                <Loader2
                                    className="size-5 shrink-0 animate-spin text-foreground-subtle"
                                    aria-hidden
                                />
                            )}
                            {working && made ? (
                                <span className="absolute right-2 top-2 rounded bg-background/80 px-2 py-1 text-xs text-foreground-subtle">
                                    {t("images.working")}
                                </span>
                            ) : null}
                        </div>

                        {facts ? (
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                                <Fact label={t("images.was")}>
                                    {t("images.size", {
                                        width: facts.width,
                                        height: facts.height,
                                        weight: weigh(facts.bytes)
                                    })}
                                </Fact>
                                <Fact label={t("images.now")}>
                                    {made
                                        ? t("images.size", { width: made.width, height: made.height, weight: weigh(made.bytes) })
                                        : "-"}
                                </Fact>
                                <Fact label={t("images.saved")}>
                                    <span
                                        className={cn(
                                            "tabular-nums",
                                            saved > 0 ? "text-success" : "text-warning"
                                        )}
                                    >
                                        {made ? `${Math.round(saved * 100)}%` : "-"}
                                    </span>
                                </Fact>
                                <Fact label={t("images.taken")}>{facts.taken ?? t("images.notRecorded")}</Fact>
                            </dl>
                        ) : null}

                        {facts?.hasLocation && keepMetadata ? (
                            <p className="flex items-start gap-2 rounded-lg border border-warning-edge bg-warning-soft p-3 text-sm">
                                <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
                                {t("images.locationWarning")}
                            </p>
                        ) : null}
                    </div>

                    <div className="flex flex-col gap-4">
                        <label className="flex flex-col gap-1.5 text-sm">
                            {t("images.format")}
                            <Select
                                aria-label={t("images.format")}
                                value={format}
                                onValueChange={setFormat}
                                options={FORMATS}
                            />
                        </label>

                        {format !== "png" ? (
                            <label className="flex flex-col gap-1.5 text-sm">
                                <span className="flex items-center justify-between gap-2">
                                    {t("images.quality")}
                                    <span className="tabular-nums text-foreground-subtle">
                                        {quality}
                                    </span>
                                </span>
                                <input
                                    type="range"
                                    min={1}
                                    max={100}
                                    step={1}
                                    value={quality}
                                    aria-label={t("images.quality")}
                                    onChange={(event) => setQuality(Number(event.target.value))}
                                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                                />
                            </label>
                        ) : (
                            <p className="text-sm text-foreground-subtle">
                                {t("images.pngNoQuality")}
                            </p>
                        )}

                        <label className="flex flex-col gap-1.5 text-sm">
                            {t("images.longest")}
                            <Input
                                inputMode="numeric"
                                placeholder={t("images.longestPlaceholder")}
                                value={longest}
                                aria-label={t("images.longestLabel")}
                                onChange={(event) =>
                                    setLongest(event.target.value.replace(/\D/g, ""))
                                }
                            />
                        </label>

                        <label className="flex items-start justify-between gap-3 text-sm">
                            <span className="flex flex-col">
                                {t("images.keepInfo")}
                                <span className="text-xs text-foreground-subtle">{t("images.keepInfoHint")}</span>
                            </span>
                            <Switch
                                checked={keepMetadata}
                                onChange={setKeepMetadata}
                                aria-label={t("images.keepInfoLabel")}
                            />
                        </label>

                        <div className="flex flex-col gap-2">
                            <Button asChild disabled={!made}>
                                <a
                                    href={made?.url ?? "#"}
                                    download={downloadName(file.name, format)}
                                    aria-disabled={!made}
                                >
                                    <Download className="size-4 shrink-0" aria-hidden />
                                    {t("images.download")}
                                </a>
                            </Button>
                            <Button variant="ghost" onClick={() => setFile(null)}>
                                {t("images.another")}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * One measurement of the picture.
 *
 * The value wraps rather than clipping. These are short - a size, a weight, a
 * percentage, a date - and every one of them is read at a glance while somebody
 * moves the quality slider, so a second line costs nothing and an ellipsis would
 * hide the number the screen exists to show.
 */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col">
            <dt className="text-xs text-foreground-subtle">{label}</dt>
            <dd className="break-words">{children}</dd>
        </div>
    );
}

/** The name the result is saved under: the original's, with the new extension.
 *  Somebody who converted `holiday.png` wants `holiday.webp`, not a timestamp. */
function downloadName(original: string, format: string): string {
    const base = original.replace(/\.[^.]+$/, "") || "picture";
    return `${base}.${format === "jpeg" ? "jpg" : format}`;
}

"use client";

/**
 * Photos and videos, looked at and finished before they are sent.
 *
 * What a phone messenger opens the moment a picture is picked: the picture big,
 * a strip of everything picked under it, a caption for each, crop and rotate,
 * a pen, words on top, and the "1" that sends it to be seen once. Full screen on
 * a phone, a dialog on a computer - the same component either way.
 *
 * Edits are data until Send (`media-edit.ts`); only then is each changed picture
 * drawn into a new file (`media-render.ts`). A video is captioned and sent as it
 * is.
 */

import { isWatchableVideo, typeOfFile } from "@/lib/mime";
import { viewOnceable } from "@/lib/chat/view-once-choice";
import { isInlinePicture } from "@/components/attachment-tile";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, cn } from "@polaris/ui";
import { Crop, Loader2, Pencil, Plus, RotateCw, SendHorizontal, Trash2, Type, Undo2 } from "lucide-react";
import * as edits from "./media-edit";
import { drawEdit, loadPicture, renderEdited } from "./media-render";

/** Whether a file is one the editor opens for: a picture or a video the
 *  conversation draws inline. */
export function isEditorMedia(file: File): boolean {
    const type = typeOfFile(file.type, file.name);
    return isInlinePicture(type) || isWatchableVideo(type);
}

type Tool = "none" | "crop" | "draw" | "text";

const COLOR_NAMES = ["white", "black", "red", "amber", "green", "blue"] as const;

interface ItemState {
    readonly edit: edits.PictureEdit;
    readonly caption: string;
}

export function MediaEditor({
    files,
    canViewOnce,
    refused,
    captured,
    onAdd,
    onRemove,
    onClose,
    onSend
}: {
    files: readonly File[];
    /** The conversation takes files sent to be seen once. */
    canViewOnce: boolean;
    /** Why something picked here was not taken, in the composer's words. */
    refused: string;
    captured: (file: File) => "camera" | "gallery" | null;
    /** More picked from the strip's +. */
    onAdd: (picked: readonly File[]) => void;
    onRemove: (file: File) => void;
    onClose: () => void;
    /** The finished items, edited pictures already drawn into new files. */
    onSend: (media: readonly edits.EditedMedia[], viewOnce: boolean) => void;
}) {
    const t = useTranslations("chat");
    const [states, setStates] = useState<ReadonlyMap<File, ItemState>>(() => new Map());
    const [selected, setSelected] = useState(0);
    const [tool, setTool] = useState<Tool>("none");
    const [color, setColor] = useState<string>(edits.MARK_COLORS[0]);
    const [words, setWords] = useState("");
    const [once, setOnce] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState("");
    const adding = useRef<HTMLInputElement | null>(null);

    const at = Math.min(selected, Math.max(0, files.length - 1));
    const file = files[at];
    const type = file ? typeOfFile(file.type, file.name) : "";
    const editable = edits.canEditPicture(type) && isInlinePicture(type);
    const state = (file && states.get(file)) || { edit: edits.NO_EDIT, caption: "" };
    const offerOnce = canViewOnce && files.every((one) => viewOnceable(typeOfFile(one.type, one.name)));

    const update = (change: (was: ItemState) => ItemState) => {
        if (!file) return;
        setStates((current) => {
            const next = new Map(current);
            next.set(file, change(current.get(file) ?? { edit: edits.NO_EDIT, caption: "" }));
            return next;
        });
    };
    const setEdit = (change: (was: edits.PictureEdit) => edits.PictureEdit) =>
        update((was) => ({ ...was, edit: change(was.edit) }));

    // Thumbnails for the strip, given back when the file leaves it.
    const thumbs = useMemo(() => files.map((one) => URL.createObjectURL(one)), [files]);
    useEffect(() => () => thumbs.forEach((address) => URL.revokeObjectURL(address)), [thumbs]);

    useEffect(() => setTool("none"), [at]);

    const send = async () => {
        if (busy || files.length === 0) return;
        setBusy(true);
        setFailed("");
        try {
            const media: edits.EditedMedia[] = [];
            for (const one of files) {
                const item = states.get(one);
                const kind = typeOfFile(one.type, one.name);
                const changed = item && edits.canEditPicture(kind) && edits.isEdited(item.edit);
                media.push({
                    file: changed ? await renderEdited(one, item.edit) : one,
                    caption: item?.caption ?? "",
                    captured: captured(one)
                });
            }
            onSend(media, offerOnce && once);
        } catch {
            setFailed(t("mediaEditor.notDrawn"));
        }
        // Still open when the composer refused what was sent.
        setBusy(false);
    };

    const toolButton = (name: Exclude<Tool, "none">, label: string, icon: React.ReactNode) => (
        <button
            type="button"
            aria-pressed={tool === name}
            aria-label={label}
            title={label}
            onClick={() => setTool((now) => (now === name ? "none" : name))}
            className={cn(
                "shrink-0 rounded-full p-2 transition-colors",
                tool === name ? "bg-primary text-primary-foreground" : "text-white hover:bg-white/15"
            )}
        >
            {icon}
        </button>
    );

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent
                phone="full"
                className="flex h-[min(90dvh,52rem)] max-h-[90dvh] max-w-3xl flex-col gap-0 overflow-hidden bg-black p-0 text-white"
            >
                <DialogTitle className="sr-only">{t("mediaEditor.title")}</DialogTitle>
                <DialogDescription className="sr-only">{t("mediaEditor.description")}</DialogDescription>

                <div className="flex shrink-0 items-center gap-1 px-3 pt-3 pe-12">
                    {editable && (
                        <>
                            {toolButton("crop", t("mediaEditor.crop"), <Crop className="size-5 shrink-0" />)}
                            {toolButton("draw", t("mediaEditor.draw"), <Pencil className="size-5 shrink-0" />)}
                            {toolButton("text", t("mediaEditor.text"), <Type className="size-5 shrink-0" />)}
                            <button
                                type="button"
                                disabled={state.edit.marks.length === 0}
                                aria-label={t("mediaEditor.undo")}
                                title={t("mediaEditor.undo")}
                                onClick={() => setEdit((edit) => ({ ...edit, marks: edit.marks.slice(0, -1) }))}
                                className="shrink-0 rounded-full p-2 text-white transition-colors hover:bg-white/15 disabled:opacity-40"
                            >
                                <Undo2 className="size-5 shrink-0" />
                            </button>
                        </>
                    )}
                    <span className="min-w-0 flex-1" />
                    <button
                        type="button"
                        disabled={busy}
                        aria-label={t("mediaEditor.remove")}
                        title={t("mediaEditor.remove")}
                        onClick={() => file && onRemove(file)}
                        className="shrink-0 rounded-full p-2 text-white transition-colors hover:bg-white/15 hover:text-danger disabled:opacity-40"
                    >
                        <Trash2 className="size-5 shrink-0" />
                    </button>
                </div>

                {tool === "crop" && editable && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => setEdit(edits.rotateEdit)}
                        >
                            <RotateCw className="size-4 shrink-0" />
                            {t("mediaEditor.rotate")}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => setEdit((edit) => ({ ...edit, crop: edits.FULL_CROP }))}
                        >
                            {t("mediaEditor.resetCrop")}
                        </Button>
                    </div>
                )}
                {(tool === "draw" || tool === "text") && editable && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-2">
                        {edits.MARK_COLORS.map((one, index) => (
                            <button
                                key={one}
                                type="button"
                                aria-pressed={color === one}
                                aria-label={t(`mediaEditor.colors.${COLOR_NAMES[index] ?? "white"}`)}
                                title={t(`mediaEditor.colors.${COLOR_NAMES[index] ?? "white"}`)}
                                onClick={() => setColor(one)}
                                style={{ backgroundColor: one }}
                                className={cn(
                                    "size-6 shrink-0 rounded-full border border-white/60",
                                    color === one && "ring-2 ring-white ring-offset-2 ring-offset-black"
                                )}
                            />
                        ))}
                        {tool === "text" && (
                            <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                                <Input
                                    value={words}
                                    maxLength={80}
                                    onChange={(event) => setWords(event.target.value)}
                                    placeholder={t("mediaEditor.textPlaceholder")}
                                    aria-label={t("mediaEditor.textPlaceholder")}
                                    className="min-w-0 flex-1"
                                />
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={words.trim().length === 0}
                                    onClick={() => {
                                        const text = words.trim();
                                        if (!text) return;
                                        const [x, y] = edits.fromView(state.edit.crop, 0.5, 0.5);
                                        setEdit((edit) => ({
                                            ...edit,
                                            marks: [...edit.marks, { kind: "text", text, color, x, y, size: 0.08 }]
                                        }));
                                        setWords("");
                                    }}
                                >
                                    {t("mediaEditor.addText")}
                                </Button>
                            </span>
                        )}
                    </div>
                )}

                <div className="relative flex min-h-0 flex-1 items-center justify-center p-3">
                    {file &&
                        (editable ? (
                            <PictureStage
                                key={`${at}:${file.name}`}
                                file={file}
                                edit={state.edit}
                                tool={tool}
                                color={color}
                                onEdit={setEdit}
                            />
                        ) : isWatchableVideo(type) ? (
                            <video
                                key={thumbs[at]}
                                src={thumbs[at]}
                                controls
                                playsInline
                                className="max-h-full max-w-full"
                            />
                        ) : (
                            // A GIF: shown, sent as it is.
                            <img src={thumbs[at]} alt={file.name} className="max-h-full max-w-full object-contain" />
                        ))}
                </div>

                {(refused || failed) && (
                    <p role="alert" className="shrink-0 px-3 pb-1 text-xs text-danger">
                        {failed || refused}
                    </p>
                )}

                <ul className="flex shrink-0 items-center gap-2 overflow-x-auto px-3 py-2">
                    {files.map((one, index) => (
                        <li key={`${one.name}:${one.lastModified}:${index}`} className="shrink-0">
                            <button
                                type="button"
                                aria-pressed={index === at}
                                aria-label={t("mediaEditor.item", { number: index + 1, count: files.length })}
                                title={one.name}
                                onClick={() => setSelected(index)}
                                className={cn(
                                    "block size-14 overflow-hidden rounded-md border-2",
                                    index === at ? "border-primary" : "border-transparent opacity-70"
                                )}
                            >
                                {isWatchableVideo(typeOfFile(one.type, one.name)) ? (
                                    <video src={thumbs[index]} muted playsInline preload="metadata" className="size-full object-cover" />
                                ) : (
                                    <img src={thumbs[index]} alt="" className="size-full object-cover" />
                                )}
                            </button>
                        </li>
                    ))}
                    <li className="shrink-0">
                        <button
                            type="button"
                            disabled={busy}
                            aria-label={t("mediaEditor.addMore")}
                            title={t("mediaEditor.addMore")}
                            onClick={() => adding.current?.click()}
                            className="flex size-14 items-center justify-center rounded-md border border-dashed border-white/40 text-white transition-colors hover:bg-white/10"
                        >
                            <Plus className="size-5 shrink-0" />
                        </button>
                        <input
                            ref={adding}
                            type="file"
                            accept="image/*,video/*"
                            multiple
                            hidden
                            onChange={(event) => {
                                const picked = Array.from(event.target.files ?? []);
                                event.target.value = "";
                                if (picked.length > 0) onAdd(picked);
                            }}
                        />
                    </li>
                </ul>

                <div className="flex shrink-0 items-center gap-2 px-3 pt-1 pb-[max(0.75rem,var(--safe-bottom))]">
                    <Input
                        value={state.caption}
                        maxLength={1000}
                        disabled={busy}
                        onChange={(event) => {
                            const caption = event.target.value;
                            update((was) => ({ ...was, caption }));
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                        placeholder={t("mediaEditor.caption")}
                        aria-label={t("mediaEditor.caption")}
                        className="min-w-0 flex-1"
                    />
                    {offerOnce && (
                        <button
                            type="button"
                            aria-pressed={once}
                            aria-label={t("mediaEditor.viewOnce")}
                            title={once ? t("mediaEditor.viewOnceOn") : t("mediaEditor.viewOnce")}
                            onClick={() => setOnce((now) => !now)}
                            className={cn(
                                "flex size-9 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold tabular-nums transition-colors",
                                once
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-white/70 text-white hover:bg-white/15"
                            )}
                        >
                            1
                        </button>
                    )}
                    <Button
                        type="button"
                        disabled={busy || files.length === 0}
                        aria-label={t("mediaEditor.send")}
                        title={t("mediaEditor.send")}
                        onClick={() => void send()}
                        className="shrink-0 rounded-full"
                    >
                        {busy ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" />
                        ) : (
                            <SendHorizontal className="size-4 shrink-0" />
                        )}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * The picture being edited, drawn on a canvas that fits the space it has.
 *
 * With the crop tool it shows the whole picture and a frame to drag; otherwise
 * the cropped picture, which the pen and the words are put on.
 */
function PictureStage({
    file,
    edit,
    tool,
    color,
    onEdit
}: {
    file: File;
    edit: edits.PictureEdit;
    tool: Tool;
    color: string;
    onEdit: (change: (was: edits.PictureEdit) => edits.PictureEdit) => void;
}) {
    const t = useTranslations("chat");
    const box = useRef<HTMLDivElement | null>(null);
    const canvas = useRef<HTMLCanvasElement | null>(null);
    const [image, setImage] = useState<HTMLImageElement | null>(null);
    const [space, setSpace] = useState({ width: 0, height: 0 });
    const [draft, setDraft] = useState<edits.StrokeMark | null>(null);
    const gesture = useRef<
        | { kind: "draw" }
        | { kind: "text"; index: number; dx: number; dy: number }
        | { kind: "crop"; handle: edits.CropHandle; x: number; y: number; from: edits.CropRect }
        | null
    >(null);

    useEffect(() => {
        let live = true;
        void loadPicture(file)
            .then((loaded) => live && setImage(loaded))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [file]);

    useEffect(() => {
        const element = box.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setSpace({ width: entry.contentRect.width, height: entry.contentRect.height });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const cropping = tool === "crop";
    const natural = image ? { width: image.naturalWidth, height: image.naturalHeight } : null;
    const turned = natural ? edits.rotatedSize(natural.width, natural.height, edit.rotation) : null;
    const view = cropping ? edits.FULL_CROP : edit.crop;
    const aspect = turned ? (turned.width * view.w) / (turned.height * view.h) : 1;
    const fit =
        space.width > 0 && space.height > 0
            ? space.width / space.height > aspect
                ? { width: space.height * aspect, height: space.height }
                : { width: space.width, height: space.width / aspect }
            : null;

    useEffect(() => {
        const element = canvas.current;
        if (!element || !image || !natural || !fit) return;
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(fit.width * ratio));
        const height = Math.max(1, Math.round(fit.height * ratio));
        element.width = width;
        element.height = height;
        const context = element.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, width, height);
        drawEdit(context, image, natural, edit, { width, height }, {
            cropped: !cropping,
            extra: draft ? [draft] : undefined
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [image, edit, draft, cropping, fit?.width, fit?.height]);

    /** A pointer's place on the picture, as a point of the whole rotated one. */
    const pointOf = (event: ReactPointerEvent): [number, number] => {
        const rect = canvas.current!.getBoundingClientRect();
        return edits.fromView(
            view,
            (event.clientX - rect.left) / Math.max(1, rect.width),
            (event.clientY - rect.top) / Math.max(1, rect.height)
        );
    };

    const turnedAspect = turned ? turned.width / turned.height : 1;

    const down = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (event.button !== 0 || !turned) return;
        if (tool === "draw") {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            gesture.current = { kind: "draw" };
            setDraft({ kind: "stroke", color, width: 0.012, points: [pointOf(event)] });
        } else if (tool === "text" || tool === "none") {
            const [x, y] = pointOf(event);
            const index = edits.textAt(edit.marks, x, y, turnedAspect);
            const mark = edit.marks[index];
            if (mark?.kind !== "text") return;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            gesture.current = { kind: "text", index, dx: mark.x - x, dy: mark.y - y };
        }
    };
    const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const current = gesture.current;
        if (!current) return;
        if (current.kind === "draw") {
            const point = pointOf(event);
            setDraft((was) => (was ? { ...was, points: [...was.points, point] } : was));
        } else if (current.kind === "text") {
            const [x, y] = pointOf(event);
            onEdit((was) => ({
                ...was,
                marks: was.marks.map((mark, index): edits.Mark =>
                    index === current.index && mark.kind === "text"
                        ? { ...mark, x: x + current.dx, y: y + current.dy }
                        : mark
                )
            }));
        }
    };
    const up = () => {
        const current = gesture.current;
        gesture.current = null;
        if (current?.kind === "draw" && draft) {
            const stroke = draft;
            onEdit((was) => ({ ...was, marks: [...was.marks, stroke] }));
            setDraft(null);
        }
    };

    const cropDown = (handle: edits.CropHandle) => (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        gesture.current = { kind: "crop", handle, x: event.clientX, y: event.clientY, from: edit.crop };
    };
    const cropMove = (event: ReactPointerEvent<HTMLElement>) => {
        const current = gesture.current;
        if (current?.kind !== "crop" || !fit) return;
        const dx = (event.clientX - current.x) / fit.width;
        const dy = (event.clientY - current.y) / fit.height;
        onEdit((was) => ({ ...was, crop: edits.dragCrop(current.from, current.handle, dx, dy) }));
    };
    const cropUp = () => {
        if (gesture.current?.kind === "crop") gesture.current = null;
    };

    const corners: { handle: edits.CropHandle; style: React.CSSProperties }[] = [
        { handle: "nw", style: { left: 0, top: 0, cursor: "nwse-resize" } },
        { handle: "ne", style: { right: 0, top: 0, cursor: "nesw-resize" } },
        { handle: "sw", style: { left: 0, bottom: 0, cursor: "nesw-resize" } },
        { handle: "se", style: { right: 0, bottom: 0, cursor: "nwse-resize" } }
    ];

    return (
        <div ref={box} className="flex size-full min-h-0 min-w-0 items-center justify-center">
            {!image && <Loader2 className="size-6 shrink-0 animate-spin text-white/70" />}
            {image && fit && (
                // Pictures are not mirrored for right-to-left: the frame sits on
                // the picture's own left and right.
                <div dir="ltr" className="relative" style={{ width: fit.width, height: fit.height }}>
                    <canvas
                        ref={canvas}
                        aria-label={file.name}
                        role="img"
                        onPointerDown={down}
                        onPointerMove={move}
                        onPointerUp={up}
                        onPointerCancel={up}
                        className={cn(
                            "block size-full touch-none select-none",
                            tool === "draw" && "cursor-crosshair"
                        )}
                    />
                    {cropping && (
                        <div className="absolute inset-0 overflow-hidden">
                            <div
                                role="group"
                                aria-label={t("mediaEditor.cropFrame")}
                                onPointerDown={cropDown("move")}
                                onPointerMove={cropMove}
                                onPointerUp={cropUp}
                                onPointerCancel={cropUp}
                                className="absolute cursor-move touch-none border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
                                style={{
                                    left: `${edit.crop.x * 100}%`,
                                    top: `${edit.crop.y * 100}%`,
                                    width: `${edit.crop.w * 100}%`,
                                    height: `${edit.crop.h * 100}%`
                                }}
                            >
                                {corners.map(({ handle, style }) => (
                                    <span
                                        key={handle}
                                        onPointerDown={cropDown(handle)}
                                        onPointerMove={cropMove}
                                        onPointerUp={cropUp}
                                        onPointerCancel={cropUp}
                                        className="absolute size-6 touch-none rounded-sm bg-white/90"
                                        style={{ ...style, margin: -12 }}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

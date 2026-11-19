/**
 * What the media editor does to a picture, as data.
 *
 * Everything is held in fractions of the picture as it stands after rotating
 * (0..1 on each axis), never in screen pixels: the same edit is drawn into the
 * small preview and into the full-size file that is uploaded, and a phone turned
 * sideways mid-edit does not move a single line. The crop, the strokes and the
 * text all live in that one frame, so cropping tighter never moves a drawing,
 * and rotating turns all three together (`rotateEdit`).
 *
 * The file is drawn again in the browser only when something was changed
 * (`isEdited`); a picture sent untouched goes as the bytes that were picked.
 */

import { DEFAULT_VIEW_SECONDS, type ViewOnceChoice } from "@/lib/chat/view-once-choice";

export type Rotation = 0 | 90 | 180 | 270;

/** A part of the picture, as fractions of it. */
export interface CropRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export interface StrokeMark {
    readonly kind: "stroke";
    readonly color: string;
    /** Line width, as a fraction of the picture's shorter side. */
    readonly width: number;
    readonly points: readonly (readonly [number, number])[];
}

export interface TextMark {
    readonly kind: "text";
    readonly text: string;
    readonly color: string;
    /** Centre of the line. */
    readonly x: number;
    readonly y: number;
    /** Font size, as a fraction of the picture's shorter side. */
    readonly size: number;
}

export type Mark = StrokeMark | TextMark;

export interface PictureEdit {
    readonly rotation: Rotation;
    readonly crop: CropRect;
    /** In the order they were made, so undo takes the last one back. */
    readonly marks: readonly Mark[];
}

export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };
export const NO_EDIT: PictureEdit = { rotation: 0, crop: FULL_CROP, marks: [] };

/** The smallest a crop may be made, on either side. */
export const MIN_CROP = 0.08;

/** The longest side an edited picture is written at. A phone photo is 4000 and
 *  more; past this nobody can tell, and the file only gets heavier. */
export const MAX_EDITED_SIDE = 4096;

/** Colours offered for drawing and text: white and black first, since they read
 *  on any photo. */
export const MARK_COLORS = ["#ffffff", "#111111", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6"] as const;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Whether anything was done to the picture at all. */
export function isEdited(edit: PictureEdit): boolean {
    const { crop } = edit;
    return (
        edit.rotation !== 0 ||
        edit.marks.length > 0 ||
        crop.x !== 0 ||
        crop.y !== 0 ||
        crop.w !== 1 ||
        crop.h !== 1
    );
}

/** A point turned a quarter clockwise with the picture under it. */
export function rotatePoint([x, y]: readonly [number, number]): [number, number] {
    return [1 - y, x];
}

/** A rectangle turned a quarter clockwise with the picture under it. */
export function rotateRect(rect: CropRect): CropRect {
    return { x: 1 - rect.y - rect.h, y: rect.x, w: rect.h, h: rect.w };
}

/** The whole edit turned a quarter clockwise: the picture, its crop and every
 *  mark on it, so nothing drawn ends up somewhere it was not put. */
export function rotateEdit(edit: PictureEdit): PictureEdit {
    return {
        rotation: ((edit.rotation + 90) % 360) as Rotation,
        crop: rotateRect(edit.crop),
        marks: edit.marks.map((mark) => {
            if (mark.kind === "stroke") return { ...mark, points: mark.points.map(rotatePoint) };
            const [x, y] = rotatePoint([mark.x, mark.y]);
            return { ...mark, x, y };
        })
    };
}

/** Which part of the crop frame is being dragged. */
export type CropHandle = "move" | "nw" | "ne" | "sw" | "se";

/**
 * The crop after dragging one of its handles by `dx`, `dy` (fractions of the
 * picture). Moving keeps the size and stays inside the picture; a corner keeps
 * the opposite corner where it is and never makes the frame smaller than
 * `MIN_CROP` or larger than the picture.
 */
export function dragCrop(rect: CropRect, handle: CropHandle, dx: number, dy: number): CropRect {
    if (handle === "move") {
        return {
            ...rect,
            x: clamp(rect.x + dx, 0, 1 - rect.w),
            y: clamp(rect.y + dy, 0, 1 - rect.h)
        };
    }
    let left = rect.x;
    let top = rect.y;
    let right = rect.x + rect.w;
    let bottom = rect.y + rect.h;
    if (handle === "nw" || handle === "sw") left = clamp(left + dx, 0, right - MIN_CROP);
    else right = clamp(right + dx, left + MIN_CROP, 1);
    if (handle === "nw" || handle === "ne") top = clamp(top + dy, 0, bottom - MIN_CROP);
    else bottom = clamp(bottom + dy, top + MIN_CROP, 1);
    return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The picture's size once rotated. */
export function rotatedSize(width: number, height: number, rotation: Rotation) {
    return rotation === 90 || rotation === 270
        ? { width: height, height: width }
        : { width, height };
}

/** The size the edited file is written at: the crop of the rotated picture, at
 *  most `MAX_EDITED_SIDE` on its longer side, and never under one pixel. */
export function outputSize(width: number, height: number, edit: PictureEdit) {
    const turned = rotatedSize(width, height, edit.rotation);
    const w = turned.width * edit.crop.w;
    const h = turned.height * edit.crop.h;
    const scale = Math.min(1, MAX_EDITED_SIDE / Math.max(w, h, 1));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** What the edited file is written as. A PNG or WebP stays one (it may have
 *  transparency); everything else becomes a JPEG. */
export function editedType(type: string): "image/png" | "image/webp" | "image/jpeg" {
    const base = type.split(";")[0]?.trim().toLowerCase();
    if (base === "image/png") return "image/png";
    if (base === "image/webp") return "image/webp";
    return "image/jpeg";
}

/** The picked name with the extension the new type needs. */
export function editedName(name: string, type: string): string {
    const extension = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" }[editedType(type)];
    const stem = name.replace(/\.[^./\\]+$/, "") || "photo";
    return `${stem}.${extension}`;
}

/**
 * Which pictures the editor offers its tools for. An animated GIF would come out
 * of a canvas as its first frame, so it is sent as it is; video is captioned and
 * sent, not drawn on.
 */
export function canEditPicture(type: string): boolean {
    const base = type.split(";")[0]?.trim().toLowerCase() ?? "";
    return base.startsWith("image/") && base !== "image/gif" && base !== "image/svg+xml";
}

/** A point on the visible (cropped) picture, as a point of the whole one. */
export function fromView(crop: CropRect, vx: number, vy: number): [number, number] {
    return [crop.x + clamp(vx, 0, 1) * crop.w, crop.y + clamp(vy, 0, 1) * crop.h];
}

/** The timer a file sent to be seen once goes with, unless the sender chose one:
 *  a photo for a few seconds, a video or a recording until it ends or is closed. */
export function defaultViewSeconds(type: string): number | null {
    return type.toLowerCase().startsWith("image/") ? DEFAULT_VIEW_SECONDS : null;
}

/** One item as the editor hands it back. */
export interface EditedMedia {
    readonly file: File;
    readonly caption: string;
    /** Where the phone app said it came from, for the view-once record. */
    readonly captured: "camera" | "gallery" | null;
}

/** One message the editor's Send turns into. */
export interface MediaMessage {
    readonly body: string;
    readonly files: readonly File[];
    readonly viewOnce: readonly ViewOnceChoice[];
}

/**
 * What the editor's Send posts.
 *
 * With no caption anywhere it is one message with every item in it, the way a
 * set of photos is sent today. With a caption on any of them, each item goes as
 * a message of its own with its own words under it - the caption belongs to that
 * picture, and in one message it would read as everybody's. `viewOnce` sends
 * every item to be seen once, each at its own default timer.
 */
export function planMediaSend(items: readonly EditedMedia[], viewOnce: boolean): MediaMessage[] {
    if (items.length === 0) return [];
    const once = (item: EditedMedia, index: number): ViewOnceChoice[] =>
        viewOnce
            ? [{ index, seconds: defaultViewSeconds(item.file.type), captured: item.captured }]
            : [];
    const captioned = items.some((item) => item.caption.trim().length > 0);
    if (!captioned) {
        return [
            {
                body: "",
                files: items.map((item) => item.file),
                viewOnce: items.flatMap((item, index) => once(item, index))
            }
        ];
    }
    return items.map((item) => ({
        body: item.caption.trim(),
        files: [item.file],
        viewOnce: once(item, 0)
    }));
}

/** Where a text mark sits, as a box of the whole picture, for picking it up. */
export function textBox(mark: TextMark, aspect: number) {
    // Measured roughly rather than by the font: this is a target for a finger,
    // and a generous one is the point.
    const tall = mark.size * Math.min(1, aspect) * 1.4;
    const wide = (mark.size * Math.min(1, aspect) * 0.62 * Math.max(1, mark.text.length)) / aspect;
    return { x: mark.x - wide / 2, y: mark.y - tall / 2, w: wide, h: tall };
}

/** The last text mark under a point, by its index in `marks`, or -1. */
export function textAt(marks: readonly Mark[], x: number, y: number, aspect: number): number {
    for (let at = marks.length - 1; at >= 0; at -= 1) {
        const mark = marks[at];
        if (mark?.kind !== "text") continue;
        const box = textBox(mark, aspect);
        if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return at;
    }
    return -1;
}

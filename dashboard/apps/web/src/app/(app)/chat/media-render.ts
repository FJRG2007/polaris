"use client";

/**
 * Drawing an edit (`media-edit.ts`) onto a canvas: the preview in the editor and
 * the file that is uploaded are drawn by this one function, so what was seen is
 * what is sent.
 *
 * The file is re-encoded from the canvas, which also drops the EXIF block - a
 * phone photo's place and time - from every picture that was edited. One sent
 * untouched is not drawn here at all.
 */

import {
    editedName,
    editedType,
    FULL_CROP,
    outputSize,
    rotatedSize,
    type CropRect,
    type PictureEdit
} from "./media-edit";

interface Natural {
    readonly width: number;
    readonly height: number;
}

/**
 * Draw `image` with `edit` applied into a `target`-sized area of `context`.
 * `cropped: false` draws the whole rotated picture, for the crop tool, which
 * shows what is being cut away.
 */
export function drawEdit(
    context: CanvasRenderingContext2D,
    image: CanvasImageSource,
    natural: Natural,
    edit: PictureEdit,
    target: Natural,
    { cropped = true, extra }: { cropped?: boolean; extra?: PictureEdit["marks"] } = {}
): void {
    const turned = rotatedSize(natural.width, natural.height, edit.rotation);
    const crop: CropRect = cropped ? edit.crop : FULL_CROP;
    const shorter = Math.min(turned.width, turned.height);
    context.save();
    context.scale(target.width / (turned.width * crop.w), target.height / (turned.height * crop.h));
    context.translate(-crop.x * turned.width, -crop.y * turned.height);

    context.save();
    if (edit.rotation === 90) {
        context.translate(turned.width, 0);
        context.rotate(Math.PI / 2);
    } else if (edit.rotation === 180) {
        context.translate(turned.width, turned.height);
        context.rotate(Math.PI);
    } else if (edit.rotation === 270) {
        context.translate(0, turned.height);
        context.rotate(-Math.PI / 2);
    }
    context.drawImage(image, 0, 0, natural.width, natural.height);
    context.restore();

    for (const mark of [...edit.marks, ...(extra ?? [])]) {
        if (mark.kind === "stroke") {
            const [first, ...rest] = mark.points;
            if (!first) continue;
            context.strokeStyle = mark.color;
            context.lineWidth = mark.width * shorter;
            context.lineCap = "round";
            context.lineJoin = "round";
            context.beginPath();
            context.moveTo(first[0] * turned.width, first[1] * turned.height);
            // A single tap is a dot, not nothing.
            if (rest.length === 0) context.lineTo(first[0] * turned.width + 0.01, first[1] * turned.height);
            for (const [x, y] of rest) context.lineTo(x * turned.width, y * turned.height);
            context.stroke();
            continue;
        }
        const size = mark.size * shorter;
        context.font = `700 ${size}px system-ui, sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        // An outline in the opposite tone, so the words read on any photo.
        context.lineWidth = Math.max(1, size * 0.14);
        context.strokeStyle = mark.color === "#111111" ? "#ffffff" : "#000000";
        context.lineJoin = "round";
        context.strokeText(mark.text, mark.x * turned.width, mark.y * turned.height);
        context.fillStyle = mark.color;
        context.fillText(mark.text, mark.x * turned.width, mark.y * turned.height);
    }
    context.restore();
}

/** A picked picture, decoded. Drawn upright: browsers apply the EXIF
 *  orientation to an `<img>`, so `naturalWidth` is already the turned width. */
export function loadPicture(file: File): Promise<HTMLImageElement> {
    const address = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(address);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(address);
            reject(new Error("unreadable picture"));
        };
        image.src = address;
    });
}

/** The edited picture, as the file that is uploaded in place of the picked one. */
export async function renderEdited(file: File, edit: PictureEdit): Promise<File> {
    const image = await loadPicture(file);
    const natural = { width: image.naturalWidth, height: image.naturalHeight };
    const size = outputSize(natural.width, natural.height, edit);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    const type = editedType(file.type);
    if (type === "image/jpeg") {
        // A JPEG has no transparency: what was see-through becomes white
        // rather than black.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, size.width, size.height);
    }
    drawEdit(context, image, natural, edit, size);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
    if (!blob) throw new Error("not encoded");
    return new File([blob], editedName(file.name, file.type), {
        type: blob.type || type,
        lastModified: Date.now()
    });
}

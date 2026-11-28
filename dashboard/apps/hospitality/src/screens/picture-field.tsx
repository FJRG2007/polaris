"use client";

/**
 * A product's or category's picture: chosen through the shared picker (this
 * computer, the phone's camera or gallery, Drive), dropped on the box or pasted. Every picture goes through the crop
 * dialog Polaris uses for every picture (square, resized, WebP, no EXIF) and is
 * stored by the app's own image route; the product keeps the address it gives.
 */

import { useState } from "react";
import { useHospitalityT } from "./i18n";
import { ImageUp, X } from "lucide-react";
import { hostUi } from "@polaris/app-host/client";
import { MENU_PICTURE_CROP } from "../model/image";
import { Button, cn, useToast } from "@polaris/ui";

const { ImageCropDialog } = hostUi.imageCropper;
const { useChooseFiles } = hostUi.filePicker;
const ACCEPTED = "image/png,image/jpeg,image/webp,image/gif";

export function PictureField(props: { value: string; onChange: (url: string) => void }) {
    const t = useHospitalityT();
    const toast = useToast();
    const [choose, picker] = useChooseFiles();
    const [file, setFile] = useState<Blob | null>(null);
    const [busy, setBusy] = useState(false);
    const [over, setOver] = useState(false);

    const take = (blob: Blob | null | undefined) => {
        if (blob && blob.type.startsWith("image/")) setFile(blob);
    };

    const upload = (blob: Blob) => {
        setBusy(true);
        fetch("/api/hospitality/images", { method: "POST", body: blob, headers: { "content-type": blob.type || "image/webp" } })
            .then(async (response) => {
                const answer = (await response.json().catch(() => ({}))) as { url?: unknown };
                if (!response.ok || typeof answer.url !== "string") throw new Error(t("picture.failed"));
                props.onChange(answer.url);
                setFile(null);
            })
            .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }))
            .finally(() => setBusy(false));
    };

    return (
        <div
            className={cn("flex min-w-0 items-center gap-3 rounded-lg border border-dashed p-2", over && "border-primary bg-primary/5")}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }}
            onPaste={(e) => take([...e.clipboardData.items].find((i) => i.type.startsWith("image/"))?.getAsFile())}
        >
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                {props.value ? <img src={props.value} alt="" className="size-full object-cover" /> : <ImageUp aria-hidden className="size-6 text-muted-foreground" />}
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void choose({ accept: ACCEPTED, title: t("picture.choose") }).then((files) => take(files[0]))}>
                    <ImageUp aria-hidden /> {t("picture.choose")}
                </Button>
                {props.value ? (
                    <Button size="sm" variant="ghost" onClick={() => props.onChange("")}>
                        <X aria-hidden /> {t("picture.remove")}
                    </Button>
                ) : null}
                <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{t("picture.hint")}</span>
            </div>
            {picker}
            {file ? <ImageCropDialog file={file} shape={MENU_PICTURE_CROP} busy={busy} onCancel={() => setFile(null)} onCropped={upload} /> : null}
        </div>
    );
}

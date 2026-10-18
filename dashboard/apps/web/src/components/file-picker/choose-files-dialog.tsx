"use client";

/**
 * The shared picker, for a screen that used to open the browser's own file
 * chooser and wants files back.
 *
 * Whatever is chosen - from this computer, a storage, or an address - arrives as
 * plain `File`s, so the screen keeps the checks it already runs on a chosen or
 * dropped file (type, size, count) and nothing downstream knows where it came
 * from.
 */

import { Loader2 } from "lucide-react";
import { asFiles } from "./as-files";
import { useRef, useState } from "react";
import type { PickedFile } from "./picked-file";
import { Dialog, DialogContent } from "@polaris/ui";
import { FilePickerDialog } from "./file-picker-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function ChooseFilesDialog({
    onFiles,
    onClose,
    onFailed,
    accept,
    multiple = false,
    title
}: {
    onFiles: (files: File[]) => void;
    onClose: () => void;
    /** A pick that could not be fetched, in a sentence the screen can show. */
    onFailed?: (message: string) => void;
    accept?: string;
    multiple?: boolean;
    title?: string;
}) {
    const t = useTranslations("components");
    const [fetching, setFetching] = useState(false);
    const busy = useRef(false);
    const cancelled = useRef(false);

    function take(picked: readonly PickedFile[]): void {
        if (picked.every((one) => one.kind === "upload")) {
            onFiles(picked.map((one) => one.file));
            return;
        }
        busy.current = true;
        setFetching(true);
        void asFiles(picked, { unreachable: t("files.fetchFailed") }).then(({ files, failed }) => {
            if (cancelled.current) return;
            if (failed.length > 0) onFailed?.(failed[0] ?? t("files.fetchFailed"));
            if (files.length > 0) onFiles(files);
            onClose();
        });
    }

    function stop(): void {
        cancelled.current = true;
        onClose();
    }

    if (fetching) {
        return (
            <Dialog open onOpenChange={(next) => (next ? undefined : stop())}>
                <DialogContent className="max-w-sm">
                    <div role="status" className="flex items-center gap-2 pr-8 text-[13px]">
                        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                        <span className="min-w-0 truncate">{t("files.fetching")}</span>
                    </div>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <FilePickerDialog
            accept={accept}
            multiple={multiple}
            title={title}
            onClose={() => {
                if (!busy.current) onClose();
            }}
            onPick={take}
        />
    );
}

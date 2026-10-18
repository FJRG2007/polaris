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

import { asFiles } from "./as-files";
import { FilePickerDialog } from "./file-picker-dialog";

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
    return (
        <FilePickerDialog
            accept={accept}
            multiple={multiple}
            title={title}
            onClose={onClose}
            onPick={(picked) =>
                void asFiles(picked).then(({ files, failed }) => {
                    if (failed.length > 0) onFailed?.(failed[0] ?? "");
                    if (files.length > 0) onFiles(files);
                })
            }
        />
    );
}

/**
 * Reading what someone dropped or picked, as files with folder-relative paths.
 *
 * A drop is not a file list. `dataTransfer.files` reports a dropped folder as one
 * zero-length entry that uploads as an empty file, and the only way to see what is
 * inside it is the FileSystem entry API - so every drop zone in the app has to walk
 * the transfer, not read `.files`. This lives here rather than in the Drive listing
 * that first needed it because the drop point and the share page take the same
 * drops and were each getting a different, poorer answer.
 */

/** A file to upload, and where it sits relative to what was dropped or picked. */
export interface UploadItem {
    file: File;
    relPath: string;
}

/** Map a FileList to upload items, preserving folder structure when present. */
export function filesToItems(fileList: FileList): UploadItem[] {
    return Array.from(fileList).map((file) => ({
        file,
        relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    }));
}

/** Read every batch from a directory reader (readEntries returns in chunks). */
function readAllEntries(reader: {
    readEntries: (cb: (entries: unknown[]) => void, err: (e: unknown) => void) => void;
}): Promise<unknown[]> {
    return new Promise((resolve) => {
        const all: unknown[] = [];
        const next = () => {
            reader.readEntries(
                (batch) => {
                    if (batch.length === 0) resolve(all);
                    else {
                        all.push(...batch);
                        next();
                    }
                },
                () => resolve(all)
            );
        };
        next();
    });
}

/**
 * Collect files (with folder-relative paths) from a drag-and-drop, walking any
 * dropped directories via the FileSystem entry API. Falls back to the flat file
 * list when the browser does not expose directory entries.
 *
 * Call it with the transfer read synchronously from the event: a DataTransfer is
 * emptied once the event handler returns, so reading it after the first await
 * yields nothing.
 */
export async function gatherDropItems(dataTransfer: DataTransfer): Promise<UploadItem[]> {
    const roots: unknown[] = [];
    for (let index = 0; index < dataTransfer.items.length; index++) {
        const item = dataTransfer.items[index] as DataTransferItem & {
            webkitGetAsEntry?: () => unknown;
        };
        const entry = item.webkitGetAsEntry?.();
        if (entry) roots.push(entry);
    }
    if (roots.length === 0) return filesToItems(dataTransfer.files);

    const out: UploadItem[] = [];
    const walk = async (entry: unknown, prefix: string): Promise<void> => {
        const node = entry as {
            isFile?: boolean;
            isDirectory?: boolean;
            name: string;
            file?: (cb: (file: File) => void, err: (e: unknown) => void) => void;
            createReader?: () => {
                readEntries: (cb: (entries: unknown[]) => void, err: (e: unknown) => void) => void;
            };
        };
        if (node.isFile && node.file) {
            const file = await new Promise<File | null>((resolve) =>
                node.file!(resolve, () => resolve(null))
            );
            if (file) out.push({ file, relPath: `${prefix}${node.name}` });
        } else if (node.isDirectory && node.createReader) {
            const children = await readAllEntries(node.createReader());
            for (const child of children) await walk(child, `${prefix}${node.name}/`);
        }
    };
    for (const root of roots) await walk(root, "");
    return out;
}

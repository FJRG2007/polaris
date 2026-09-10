"use client";

/**
 * A folder as a service's source: dropped or chosen here, zipped in the browser,
 * and sent to the service, which builds it with the same detection a repository
 * gets. A zip is taken as it is.
 *
 * `node_modules` and `.git` are left out on the way: the build installs what the
 * project needs, and neither belongs in what is sent. The same two are skipped on
 * the server too, so a zip made elsewhere is treated the same.
 *
 * Inside the Polaris desktop app, "Choose folder" hands the folder to the app,
 * which zips it from the disk with the same exclusions and limits - they are
 * copied in `desktop/src/main/zip-rules.ts`, and a change here belongs there too.
 */

import * as deployActions from "./actions";
import { formatBytes } from "@polaris/core";
import { Button, Input, cn } from "@polaris/ui";
import { FolderUp, Loader2 } from "lucide-react";
import { uploadedSourceAction } from "./source-actions";
import { useDesktopBridge } from "@/components/desktop-app";
import type { UploadedSource } from "@/lib/deploy/source-upload";
import { useEffect, useRef, useState, useTransition, type DragEvent, type ReactNode } from "react";

/** The largest zip the server takes, and the most a folder may hold before it. */
const MAX_ZIP = 200 * 1024 ** 2;
const MAX_FOLDER = 1024 ** 3;
const SKIPPED = new Set(["node_modules", ".git", "__MACOSX"]);

/** What is about to be sent: the zip, the folder's name, and how much is in it. */
export interface PickedSource {
    readonly blob: Blob;
    readonly name: string;
    readonly files: number;
}

interface PickedFile {
    readonly path: string;
    readonly file: File;
}

function skipped(path: string): boolean {
    return path.split("/").some((segment) => SKIPPED.has(segment)) || path.endsWith(".DS_Store");
}

/** Every file under a dropped entry, with its path from the dropped folder. */
async function walk(entry: FileSystemEntry, prefix: string, into: PickedFile[]): Promise<void> {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (skipped(path)) return;
    if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
            (entry as FileSystemFileEntry).file(resolve, reject)
        );
        into.push({ path, file });
        return;
    }
    for (const child of await readChildren(entry as FileSystemDirectoryEntry)) await walk(child, path, into);
}

/** Zip the picked files in the browser, refusing a folder too big to send. */
async function zipped(files: readonly PickedFile[], name: string): Promise<PickedSource> {
    const total = files.reduce((sum, item) => sum + item.file.size, 0);
    if (files.length === 0) throw new Error("There are no files in that folder.");
    if (total > MAX_FOLDER) throw new Error(`That folder holds more than ${formatBytes(MAX_FOLDER)}.`);
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    for (const item of files) zip.file(item.path, item.file);
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    if (blob.size > MAX_ZIP) throw new Error(`Zipped, that folder is larger than ${formatBytes(MAX_ZIP)}.`);
    return { blob, name, files: files.length };
}

/** A single dropped or chosen zip, taken as it is. */
function asZip(file: File): PickedSource {
    if (file.size > MAX_ZIP) throw new Error(`That zip is larger than ${formatBytes(MAX_ZIP)}.`);
    return { blob: file, name: file.name.replace(/\.zip$/i, ""), files: 0 };
}

/** Send a picked source to a service, deploying it when asked. */
export async function sendSource(
    applicationId: string,
    picked: PickedSource,
    deploy: boolean
): Promise<{ error?: string; deployError?: string; upload?: UploadedSource }> {
    const response = await fetch(`/api/deploy/apps/${applicationId}/source${deploy ? "?deploy=1" : ""}`, {
        method: "POST",
        headers: { "content-type": "application/zip", "x-polaris-name": encodeURIComponent(picked.name) },
        body: picked.blob
    }).catch(() => null);
    if (!response) return { error: "Could not reach Polaris. Check the connection and try again." };
    const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        deployError?: string;
        upload?: UploadedSource;
    };
    if (!response.ok) return { error: body.error ?? "Could not upload the folder" };
    return body;
}

/** A drop target for a folder or a zip, with buttons for choosing either. */
export function SourceDropZone({
    picked,
    onPicked,
    disabled
}: {
    picked: PickedSource | null;
    onPicked: (picked: PickedSource | null, error?: string) => void;
    disabled?: boolean;
}) {
    const folderInput = useRef<HTMLInputElement>(null);
    const zipInput = useRef<HTMLInputElement>(null);
    const [over, setOver] = useState(false);
    const [reading, setReading] = useState(false);
    const desktop = useDesktopBridge();

    useEffect(() => {
        // Not in React's typings: the attribute that makes a file input pick a folder.
        folderInput.current?.setAttribute("webkitdirectory", "");
    }, []);

    async function take(work: () => Promise<PickedSource | null>) {
        setReading(true);
        try {
            const next = await work();
            if (next) onPicked(next);
        } catch (caught) {
            onPicked(null, caught instanceof Error ? caught.message : "Could not read that");
        } finally {
            setReading(false);
        }
    }

    function dropped(event: DragEvent<HTMLDivElement>) {
        event.preventDefault();
        setOver(false);
        if (disabled) return;
        const items = [...event.dataTransfer.items];
        const entries = items.map((item) => item.webkitGetAsEntry()).filter((entry) => entry !== null);
        const single = entries.length === 1 ? entries[0] : undefined;
        if (single?.isFile && single.name.toLowerCase().endsWith(".zip")) {
            const file = event.dataTransfer.files[0];
            if (file) void take(async () => asZip(file));
            return;
        }
        void take(async () => {
            const files: PickedFile[] = [];
            if (single?.isDirectory) {
                // Under the folder's own name, the shape any zipped folder has; the
                // server takes a single folder holding everything as the root.
                await walk(single, "", files);
                return zipped(files, single.name);
            }
            for (const entry of entries) await walk(entry, "", files);
            return zipped(files, "upload");
        });
    }

    /** Inside the desktop app the folder is picked with the system's dialog and
     *  zipped from the disk, skipping node_modules without reading it. */
    function chooseFolder() {
        if (!desktop) {
            folderInput.current?.click();
            return;
        }
        void take(async () => {
            const picked = await desktop.pickFolder();
            if (!picked) return null;
            if (!picked.ok) throw new Error(picked.error);
            return { blob: new Blob([picked.zip], { type: "application/zip" }), name: picked.name, files: picked.files };
        });
    }

    function chosenFolder(list: FileList | null) {
        if (!list || list.length === 0) return;
        void take(async () => {
            // "folder/src/index.ts", under the folder's own name like a dropped one.
            const files = [...list].flatMap((file) => {
                const path = file.webkitRelativePath || file.name;
                return skipped(path) ? [] : [{ path, file }];
            });
            return zipped(files, list[0]?.webkitRelativePath.split("/")[0] || "upload");
        });
    }

    return (
        <div
            onDragOver={(event) => {
                event.preventDefault();
                if (!disabled) setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={dropped}
            className={cn(
                "flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm",
                over && "border-primary bg-primary/5"
            )}
        >
            {reading ? (
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
                <FolderUp className="size-5 text-muted-foreground" />
            )}
            {picked ? (
                <span className="font-medium">
                    {picked.name}
                    <span className="block text-xs font-normal text-muted-foreground">
                        {picked.files > 0 ? `${picked.files} files, ` : ""}
                        {formatBytes(picked.blob.size)} to send
                    </span>
                </span>
            ) : (
                <span className="text-muted-foreground">Drop a folder or a .zip here</span>
            )}
            <div className="flex flex-wrap justify-center gap-2">
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={disabled || reading}
                    onClick={chooseFolder}
                >
                    Choose folder
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={disabled || reading}
                    onClick={() => zipInput.current?.click()}
                >
                    Choose zip
                </Button>
            </div>
            <input
                ref={folderInput}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                    chosenFolder(event.target.files);
                    event.target.value = "";
                }}
            />
            <input
                ref={zipInput}
                type="file"
                accept=".zip,application/zip"
                hidden
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void take(async () => asZip(file));
                    event.target.value = "";
                }}
            />
            <span className="text-xs text-muted-foreground">node_modules and .git are left out.</span>
        </div>
    );
}

/** A dropped folder's own entries: a directory reader answers in batches until it
 *  answers with none. */
async function readChildren(folder: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
    const reader = folder.createReader();
    const all: FileSystemEntry[] = [];
    for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) return all;
        all.push(...batch);
    }
}

/** A new service from a folder: create it, send the folder, deploy it. */
export function NewFolderForm({
    environmentId,
    serverField,
    serverId,
    onDone
}: {
    environmentId: string;
    serverField: ReactNode;
    serverId: string;
    onDone: () => void;
}) {
    const [name, setName] = useState("");
    const [picked, setPicked] = useState<PickedSource | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        if (!picked) return;
        setError(null);
        startTransition(async () => {
            const created = await deployActions.createApplicationAction({
                environmentId,
                name: name.trim() || picked.name,
                sourceType: "upload",
                serverId
            });
            if (created.error || !created.applicationId) {
                setError(created.error ?? "Could not create the service");
                return;
            }
            const sent = await sendSource(created.applicationId, picked, true);
            if (sent.error) setError(`The service was created, but the folder did not arrive: ${sent.error}`);
            else if (sent.deployError) setError(sent.deployError);
            else onDone();
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Name</span>
                <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={picked?.name ?? "my-app"}
                    autoFocus
                />
            </label>
            {serverField}
            <SourceDropZone
                picked={picked}
                disabled={pending}
                onPicked={(next, reason) => {
                    setPicked(next);
                    setError(reason ?? null);
                    if (next && !name.trim()) setName(next.name);
                }}
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button onClick={submit} disabled={pending || !picked}>
                    {pending && <Loader2 className="size-4 animate-spin" />} Deploy
                </Button>
            </div>
        </div>
    );
}

/** On a service built from an upload: what it was last built from, and a place
 *  to send a newer folder. Nothing for a service built any other way. */
export function UploadedSourceSection({ applicationId, onChanged }: { applicationId: string; onChanged: () => void }) {
    const [state, setState] = useState<{ upload: UploadedSource | null; uploadable: boolean } | null>(null);
    const [picked, setPicked] = useState<PickedSource | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let active = true;
        void uploadedSourceAction(applicationId).then((result) => {
            if (active && !result.error) setState({ upload: result.upload ?? null, uploadable: Boolean(result.uploadable) });
        });
        return () => {
            active = false;
        };
    }, [applicationId]);

    if (!state?.uploadable) return null;

    function send() {
        if (!picked) return;
        setError(null);
        startTransition(async () => {
            const sent = await sendSource(applicationId, picked, true);
            if (sent.error) {
                setError(sent.error);
                return;
            }
            setState((current) => (current ? { ...current, upload: sent.upload ?? current.upload } : current));
            setPicked(null);
            if (sent.deployError) setError(sent.deployError);
            onChanged();
        });
    }

    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Uploaded source</h3>
            <div className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm">
                {state.upload ? (
                    <p className="text-xs text-muted-foreground">
                        Built from <span className="font-medium text-foreground">{state.upload.name}</span>:{" "}
                        {state.upload.files} files, {formatBytes(state.upload.bytes)}.
                    </p>
                ) : (
                    <p className="text-xs text-muted-foreground">Nothing uploaded yet.</p>
                )}
                <SourceDropZone
                    picked={picked}
                    disabled={pending}
                    onPicked={(next, reason) => {
                        setPicked(next);
                        setError(reason ?? null);
                    }}
                />
                {error && <p className="text-sm text-danger">{error}</p>}
                <div className="flex justify-end">
                    <Button onClick={send} disabled={pending || !picked}>
                        {pending && <Loader2 className="size-4 animate-spin" />} Upload and deploy
                    </Button>
                </div>
            </div>
        </section>
    );
}

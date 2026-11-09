"use client";

/**
 * Files picked into a Polar composer, uploaded to Polar's attachment store as
 * they are picked. Chat stages them for a model; Code hands their ids to the
 * agent session, which copies them into its working directory. One upload, one
 * set of refusals, so the two sides take the same files the same way.
 */

import { sendFile } from "@/components/transfers/move-file";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AttachmentData } from "@/components/polar/elements/attachments";
import {
    polarAttachmentId,
    POLAR_ATTACHMENT_MAX_BYTES,
    POLAR_ATTACHMENT_MOST,
    POLAR_ATTACHMENT_TYPES
} from "@/lib/polar/shared";

/** Upload refusals the composer explains; anything else reads as a failed upload. */
export const UPLOAD_ERRORS = [
    "unsupported_type",
    "too_large",
    "rate_limited",
    "storage_failed",
    "upload_failed",
    "not_found"
] as const;
export type UploadError = (typeof UPLOAD_ERRORS)[number];

/** Why a file cannot be attached at all, decided before a byte is sent. */
export function refusalOf(file: Pick<File, "type" | "size">): UploadError | null {
    if (!(POLAR_ATTACHMENT_TYPES as readonly string[]).includes(file.type))
        return "unsupported_type";
    if (file.size > POLAR_ATTACHMENT_MAX_BYTES) return "too_large";
    return null;
}

export async function uploadFile(
    file: File,
    onProgress: (share: number) => void
): Promise<AttachmentData | string> {
    const sent = await sendFile(
        `/api/polar/attachments?name=${encodeURIComponent(file.name)}`,
        file,
        {
            method: "POST",
            onProgress: (moved, total) => onProgress(total > 0 ? moved / total : 0)
        }
    ).catch(() => null);
    let body: {
        error?: string;
        file?: { id: string; url: string; filename: string; mediaType: string };
    } | null = null;
    try {
        body = sent?.body ? JSON.parse(sent.body) : null;
    } catch {
        body = null;
    }
    if (!sent?.ok || !body?.file) return body?.error ?? "upload_failed";
    return {
        id: body.file.id,
        url: body.file.url,
        filename: body.file.filename,
        mediaType: body.file.mediaType,
        size: file.size
    };
}

/** The stored ids of the files that finished uploading, in order. */
export function storedIds(files: readonly AttachmentData[]): string[] {
    return files.flatMap((file) => {
        const id = file.pending || file.failed ? null : polarAttachmentId(file.url);
        return id ? [id] : [];
    });
}

/**
 * Files from the computer on one composer: picked, uploaded, retried and
 * removed. `clear` empties it after a send without deleting what was sent.
 */
export function usePolarUploads() {
    const t = useTranslations("polar");
    const [files, setFiles] = useState<AttachmentData[]>([]);
    const [error, setError] = useState<string | null>(null);
    const picked = useRef(new Map<string, File>());
    const keys = useRef(0);

    // Object addresses die with the composer.
    const live = useRef(files);
    useEffect(() => {
        live.current = files;
    }, [files]);
    useEffect(
        () => () => {
            for (const file of live.current) if (file.preview) URL.revokeObjectURL(file.preview);
        },
        []
    );

    const upload = useCallback(
        async (key: string, file: File) => {
            const stored = await uploadFile(file, (share) =>
                setFiles((current) =>
                    current.map((entry) => (entry.id === key ? { ...entry, progress: share } : entry))
                )
            );
            if (typeof stored === "string") {
                const code: UploadError = (UPLOAD_ERRORS as readonly string[]).includes(stored)
                    ? (stored as UploadError)
                    : "upload_failed";
                const sentence = t(`files.errors.${code}`, { name: file.name });
                setFiles((current) =>
                    current.map((entry) =>
                        entry.id === key ? { ...entry, pending: false, failed: sentence } : entry
                    )
                );
                setError(sentence);
                return;
            }
            picked.current.delete(key);
            setFiles((current) =>
                current.map((entry) =>
                    entry.id === key ? { ...stored, id: entry.id, preview: entry.preview } : entry
                )
            );
        },
        [t]
    );

    const add = (chosen: File[]) => {
        const refused: string[] = [];
        const accepted = chosen.filter((file) => {
            const refusal = refusalOf(file);
            if (refusal) refused.push(t(`files.errors.${refusal}`, { name: file.name }));
            return !refusal;
        });
        const room = Math.max(0, POLAR_ATTACHMENT_MOST - live.current.length);
        if (accepted.length > room)
            refused.push(t("files.tooMany", { most: POLAR_ATTACHMENT_MOST }));
        setError(refused.length > 0 ? refused.join(" ") : null);
        for (const file of accepted.slice(0, room)) {
            keys.current += 1;
            const key = `upload-${keys.current}`;
            const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
            picked.current.set(key, file);
            const entry: AttachmentData = {
                id: key,
                url: "",
                filename: file.name,
                mediaType: file.type,
                size: file.size,
                pending: true,
                progress: 0,
                preview
            };
            live.current = [...live.current, entry];
            setFiles((current) => [...current, entry]);
            void upload(key, file);
        }
    };

    const retry = (file: AttachmentData) => {
        const original = picked.current.get(file.id);
        if (!original) return;
        setError(null);
        setFiles((current) =>
            current.map((entry) =>
                entry.id === file.id
                    ? { ...entry, pending: true, progress: 0, failed: undefined }
                    : entry
            )
        );
        void upload(file.id, original);
    };

    const remove = (file: AttachmentData) => {
        setFiles((current) => current.filter((entry) => entry.id !== file.id));
        if (file.preview) URL.revokeObjectURL(file.preview);
        picked.current.delete(file.id);
        const stored = file.pending ? null : polarAttachmentId(file.url);
        if (stored) {
            void fetch(`/api/polar/attachments/${encodeURIComponent(stored)}`, {
                method: "DELETE"
            }).catch(() => undefined);
        }
    };

    /** After a send: the files are the session's now, so nothing is deleted. */
    const clear = () => {
        for (const file of live.current) if (file.preview) URL.revokeObjectURL(file.preview);
        picked.current.clear();
        live.current = [];
        setFiles([]);
        setError(null);
    };

    return {
        files,
        error,
        setError,
        add,
        retry,
        remove,
        clear,
        /** Whether a file is still on its way, so a send would leave it behind. */
        uploading: files.some((file) => file.pending),
        failed: files.some((file) => file.failed),
        ids: storedIds(files)
    };
}

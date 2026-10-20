"use client";

/**
 * A shared Polar chat's messages, read-only: the question on the right, the
 * answer below it, the way the chat itself lays them out, with the files the
 * snapshot shows. Drawn by the public link's page and by the page of a chat
 * somebody sent you, which differ only in where a file is read from.
 */

import { cn } from "@polaris/ui";
import { FileText } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MessageResponse } from "@/components/polar/elements/message";
import type { SharedPolarFile, SharedPolarMessage } from "@/lib/polar/shared";

const PICTURES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function SharedMessages({
    messages,
    fileUrl
}: {
    messages: readonly SharedPolarMessage[];
    fileUrl: (id: string) => string;
}) {
    const t = useTranslations("polar");
    if (messages.length === 0)
        return <p className="text-sm text-muted-foreground">{t("sharing.empty")}</p>;
    return (
        <ol className="flex min-w-0 flex-col gap-4">
            {messages.map((message) => (
                <li
                    key={message.id}
                    className={cn(
                        "flex min-w-0 flex-col gap-2",
                        message.role === "user" && "ml-auto max-w-[85%] items-end"
                    )}
                >
                    <span className="sr-only">
                        {t(message.role === "user" ? "sharing.you" : "sharing.assistant")}
                    </span>
                    {message.files.length > 0 ? (
                        <Files files={message.files} fileUrl={fileUrl} />
                    ) : null}
                    {message.text ? (
                        message.role === "user" ? (
                            <p className="min-w-0 whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground">
                                {message.text}
                            </p>
                        ) : (
                            <MessageResponse>{message.text}</MessageResponse>
                        )
                    ) : null}
                </li>
            ))}
        </ol>
    );
}

function Files({
    files,
    fileUrl
}: {
    files: readonly SharedPolarFile[];
    fileUrl: (id: string) => string;
}) {
    const t = useTranslations("polar");
    const nameOf = (file: SharedPolarFile) => file.name ?? t("sharing.unnamedFile");
    return (
        <ul className="flex min-w-0 flex-wrap justify-end gap-2">
            {files.map((file) => (
                <li key={file.id} className="min-w-0">
                    {/* A plain anchor: a router link would prefetch the file. */}
                    <a
                        href={fileUrl(file.id)}
                        target="_blank"
                        rel="noreferrer"
                        title={t("sharing.file", { name: nameOf(file) })}
                        aria-label={t("sharing.file", { name: nameOf(file) })}
                        className="flex min-w-0 max-w-[16rem] items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground hover:bg-card-hover"
                    >
                        {PICTURES.has(file.mediaType) ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={fileUrl(file.id)}
                                alt=""
                                className="size-10 shrink-0 rounded object-cover"
                            />
                        ) : (
                            <FileText className="size-4 shrink-0" />
                        )}
                        <span className="min-w-0 truncate" title={nameOf(file)}>
                            {nameOf(file)}
                        </span>
                    </a>
                </li>
            ))}
        </ul>
    );
}

"use client";

/**
 * What the composer is about to send when the writer chose to send in another
 * language: the translation itself, in full, before anything leaves - so the
 * words the room reads are words the writer saw. Nothing goes out translated
 * without this strip having been on screen.
 */

import { Button } from "@polaris/ui";
import * as core from "@polaris/core";
import { Languages } from "lucide-react";
import { plainText } from "@/components/rich-text/excerpt";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { languageLabel } from "@/components/text-translation/language-select";

/** A translation of what was typed, asked for when Send was pressed. */
export type OutgoingPreview =
    | { readonly source: string; readonly to: string; readonly phase: "working" }
    | {
          readonly source: string;
          readonly to: string;
          readonly phase: "ready";
          readonly text: string;
          readonly detected: string | null;
      }
    | { readonly source: string; readonly to: string; readonly phase: "failed" };

/** The record a translated message carries, or null when what came back
 *  cannot be stored as one - then it goes as written. */
export function sentRecord(
    preview: OutgoingPreview,
    original: string
): core.ChatSentTranslation | null {
    if (preview.phase !== "ready") return null;
    const from = core.chatLanguageCode.safeParse(preview.detected);
    const parsed = core.chatSentTranslationSchema.safeParse({
        from: from.success ? from.data : null,
        to: preview.to,
        original
    });
    return parsed.success ? parsed.data : null;
}

/** Whether a translation fits in a message of at most `max` characters,
 *  counted in code points the way the server counts them. */
export function fitsLength(text: string, max: number): boolean {
    return [...text.trim()].length <= max;
}

/** The line that says, before anything is typed, where messages go out. */
export function OutgoingLanguageNote({ to }: { to: string }) {
    const t = useTranslations("chat");
    const locale = useLocale();
    return (
        <p className="mb-1 flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-foreground-subtle">
            <Languages className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
                {t("translation.outgoingOn", { language: languageLabel(to, locale) })}
            </span>
        </p>
    );
}

export function OutgoingTranslationStrip({
    preview,
    maxLength,
    onSendTranslation,
    onSendOriginal,
    onCancel
}: {
    preview: OutgoingPreview;
    maxLength: number;
    onSendTranslation: () => void;
    onSendOriginal: () => void;
    onCancel: () => void;
}) {
    const t = useTranslations("chat");
    const locale = useLocale();
    const language = languageLabel(preview.to, locale);
    const sendable = preview.phase === "ready" && fitsLength(preview.text, maxLength);
    return (
        <div
            role="region"
            aria-label={t("translation.previewTitle", { language })}
            aria-live="polite"
            className="mb-2 flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2"
        >
            <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Languages className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">
                    {preview.phase === "working"
                        ? t("translation.previewWorking", { language })
                        : t("translation.previewTitle", { language })}
                </span>
            </p>
            {preview.phase === "ready" && (
                <p
                    data-testid="outgoing-translation"
                    className="max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-sm"
                >
                    {/* The Markdown that goes, read as the room reads it rather
                        than with its asterisks and brackets showing. */}
                    {plainText(preview.text)}
                </p>
            )}
            {preview.phase === "failed" && (
                <p className="text-xs text-danger">{t("translation.previewFailed")}</p>
            )}
            {preview.phase === "ready" && !sendable && (
                <p className="text-xs text-danger">
                    {t("translation.previewTooLong", { count: maxLength })}
                </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" size="xs" onClick={onCancel}>
                    {t("translation.keepEditing")}
                </Button>
                <Button
                    variant={sendable ? "outline" : "primary"}
                    size="xs"
                    disabled={preview.phase === "working"}
                    onClick={onSendOriginal}
                >
                    {t("translation.sendAsWritten")}
                </Button>
                {sendable && (
                    <Button size="xs" onClick={onSendTranslation} autoFocus>
                        {t("translation.sendTranslation")}
                    </Button>
                )}
            </div>
        </div>
    );
}

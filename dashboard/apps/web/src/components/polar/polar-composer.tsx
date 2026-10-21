"use client";

/**
 * Polar's composer, the one both sides of Polar type into: the chips above the
 * box, the attached files, the box itself, and the tool row under it - attach,
 * the microphone, the picker, and the button that sends or opens a voice
 * conversation. Chat and Code each pass what differs (what sending does, what
 * the picker picks) and nothing else, so the two cannot drift apart.
 *
 * A control one side cannot use stays where it is, switched off, with the
 * reason on it: an agent session cannot take files or a voice conversation,
 * and saying so beats a composer that is missing buttons.
 */

import Link from "next/link";
import { Paperclip, X } from "lucide-react";
import { cn } from "@polaris/ui";
import type { Payer } from "@/lib/polar/shared";
import type { VoiceAvailability } from "@/lib/polar/voice-call";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { BorderBeam } from "@/components/polar/motion/border-beam";
import { useRef, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import { AttachmentList, type AttachmentData } from "@/components/polar/elements/attachments";
import { DictationButton, VoiceModeButton, type VoiceNotice } from "@/components/polar/polar-voice";
import {
    PromptInput,
    PromptInputAttach,
    PromptInputButton,
    PromptInputFooter,
    PromptInputHeader,
    PromptInputSubmit,
    PromptInputTextarea,
    PromptInputTools
} from "@/components/polar/elements/prompt-input";

/** What the microphone needs, owned by Polar's chat and lent to Code. */
export interface PolarVoiceKit {
    readonly voice: VoiceAvailability;
    /** Who pays, as picked for the chat. */
    readonly payer: Payer | null;
    readonly onTranscriber: (id: string) => void;
    /** Whether the reader may set the deployment's models, for the notice's link. */
    readonly isAdmin: boolean;
}

/** Files on this composer, or why it cannot take any. */
export type ComposerAttach =
    | { readonly refusal: string }
    | {
          readonly files: AttachmentData[];
          readonly error: string | null;
          readonly accept: readonly string[];
          readonly disabled: boolean;
          readonly onFiles: (files: File[]) => void;
          readonly onFailed: (message: string) => void;
          readonly onRemove: (file: AttachmentData) => void;
          readonly onRetry: (file: AttachmentData) => void;
      };

/** A voice conversation from this composer, or why there is none. */
export type ComposerVoiceMode =
    { readonly refusal: string } | { readonly disabled: boolean; readonly onOpen: () => void };

type TextareaExtras = Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "id" | "value" | "onChange" | "disabled" | "placeholder" | "maxLength"
>;

export function PolarComposer({
    kit,
    notice,
    onNotice,
    inputId,
    label,
    value,
    onValueChange,
    placeholder,
    disabled,
    maxLength = 20_000,
    textareaRef,
    textareaProps,
    onSubmit,
    header,
    beforeInput,
    picker,
    attach,
    attachId,
    voiceMode,
    submit,
    streaming = false,
    hidden = false,
    highlighted = false,
    className
}: {
    kit: PolarVoiceKit;
    notice: VoiceNotice | null;
    onNotice: (notice: VoiceNotice | null) => void;
    inputId: string;
    /** The box's name, for a screen reader. */
    label: string;
    value: string;
    onValueChange: (value: string) => void;
    placeholder: string;
    disabled: boolean;
    maxLength?: number;
    textareaRef?: Ref<HTMLTextAreaElement>;
    /** Keys, paste and the like, for a side that does more with the box. */
    textareaProps?: TextareaExtras;
    onSubmit: () => void;
    /** Chips above the box: the page, a reply, an edit. */
    header?: ReactNode;
    /** Drawn between the notices and the box. */
    beforeInput?: ReactNode;
    /** The model (Chat) or the agent (Code), drawn the same way. */
    picker: ReactNode;
    attach: ComposerAttach;
    /** The id the attach button sits under, for a command that presses it. */
    attachId?: string;
    voiceMode: ComposerVoiceMode;
    submit: {
        busy: boolean;
        disabled: boolean;
        sendLabel: string;
        stopLabel: string;
        onStop: () => void;
    };
    /** Whether an answer is streaming in, which the border shows. */
    streaming?: boolean;
    /** Hidden but kept mounted, so a draft survives a voice conversation. */
    hidden?: boolean;
    /** Something is being dragged over it. */
    highlighted?: boolean;
    className?: string;
}) {
    const t = useTranslations("polar");
    const own = useRef<HTMLTextAreaElement | null>(null);
    // A transcription lands after the recording ends: it joins what is in the
    // box then, not what was there when the microphone was pressed.
    const latest = useRef(value);
    latest.current = value;
    const files = "files" in attach ? attach.files : [];
    const empty = !value.trim() && files.length === 0;

    const setRef = (node: HTMLTextAreaElement | null) => {
        own.current = node;
        if (typeof textareaRef === "function") textareaRef(node);
        else if (textareaRef) (textareaRef as { current: unknown }).current = node;
    };

    return (
        <BorderBeam active={streaming} className={cn(hidden && "hidden", className)}>
            <PromptInput
                onSubmit={onSubmit}
                className={cn(highlighted && "border-primary bg-primary/10")}
            >
                <PromptInputHeader>{header}</PromptInputHeader>
                {"files" in attach ? (
                    <>
                        <AttachmentList
                            files={attach.files}
                            className="mb-2 mt-1"
                            onRemove={attach.onRemove}
                            onRetry={attach.onRetry}
                        />
                        {attach.error ? (
                            <p role="alert" className="mb-1 text-xs text-danger-ink">
                                {attach.error}
                            </p>
                        ) : null}
                    </>
                ) : null}
                {notice ? (
                    <VoiceNoticeLine
                        notice={notice}
                        isAdmin={kit.isAdmin}
                        onDismiss={() => onNotice(null)}
                    />
                ) : null}
                {beforeInput}
                <label htmlFor={inputId} className="sr-only">
                    {label}
                </label>
                <PromptInputTextarea
                    {...textareaProps}
                    ref={setRef}
                    id={inputId}
                    value={value}
                    maxLength={maxLength}
                    disabled={disabled}
                    placeholder={placeholder}
                    onChange={(event) => onValueChange(event.target.value)}
                    onSubmitKey={onSubmit}
                />
                <PromptInputFooter>
                    <PromptInputTools>
                        <span id={attachId} className="contents">
                            {"files" in attach ? (
                                <PromptInputAttach
                                    label={t("files.add")}
                                    accept={attach.accept}
                                    disabled={attach.disabled}
                                    onFiles={attach.onFiles}
                                    onFailed={attach.onFailed}
                                />
                            ) : (
                                // aria-disabled rather than disabled, so the
                                // reason is still there on hover and focus.
                                <PromptInputButton
                                    label={attach.refusal}
                                    aria-disabled
                                    className="opacity-50"
                                    onClick={(event) => event.preventDefault()}
                                >
                                    <Paperclip />
                                </PromptInputButton>
                            )}
                        </span>
                        <DictationButton
                            available={kit.voice.dictation}
                            disabled={disabled}
                            payer={kit.payer}
                            transcribers={kit.voice.transcribers}
                            transcriber={kit.voice.transcriber}
                            onTranscriber={kit.onTranscriber}
                            onNotice={onNotice}
                            onText={(text) => {
                                const now = latest.current;
                                onValueChange(now.trim() ? `${now.trimEnd()} ${text}` : text);
                                own.current?.focus();
                            }}
                        />
                        {picker}
                    </PromptInputTools>
                    {/* One button, as in ChatGPT: with nothing typed or attached
                        it starts a voice conversation, and it sends once there is
                        something to send. */}
                    {!submit.busy && empty ? (
                        "refusal" in voiceMode ? (
                            <VoiceModeButton
                                primary
                                available={false}
                                refusal={voiceMode.refusal}
                                onNotice={onNotice}
                                onOpen={() => undefined}
                            />
                        ) : (
                            <VoiceModeButton
                                primary
                                available={kit.voice.dictation}
                                disabled={voiceMode.disabled}
                                onNotice={onNotice}
                                onOpen={voiceMode.onOpen}
                            />
                        )
                    ) : (
                        <PromptInputSubmit {...submit} />
                    )}
                </PromptInputFooter>
            </PromptInput>
        </BorderBeam>
    );
}

/** What went wrong with the microphone or a voice conversation, with the link
 *  that fixes it where there is one. */
function VoiceNoticeLine({
    notice,
    isAdmin,
    onDismiss
}: {
    notice: VoiceNotice;
    isAdmin: boolean;
    onDismiss: () => void;
}) {
    const t = useTranslations("polar");
    return (
        <div
            role="alert"
            className="mb-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs"
        >
            <span
                className={notice === "unavailable" ? "text-muted-foreground" : "text-danger-ink"}
            >
                {notice === "unavailable"
                    ? t("voice.unavailable")
                    : notice === "micDenied" ||
                        notice === "cannotRecord" ||
                        notice === "modelNotSaved"
                      ? t(`voice.${notice}`)
                      : t(`voice.errors.${notice}`)}
            </span>
            {notice === "unavailable" ? (
                <>
                    <Link href="/account/ai-keys" className="text-primary hover:underline">
                        {t("noKeys.own")}
                    </Link>
                    {isAdmin ? (
                        <Link
                            href="/admin/integrations/models"
                            className="text-primary hover:underline"
                        >
                            {t("noKeys.admin")}
                        </Link>
                    ) : null}
                </>
            ) : null}
            <button
                type="button"
                className="ml-auto text-muted-foreground hover:text-foreground"
                aria-label={t("voice.dismiss")}
                title={t("voice.dismiss")}
                onClick={onDismiss}
            >
                <X className="size-3.5" />
            </button>
        </div>
    );
}

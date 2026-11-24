"use client";

/**
 * The "+" at the start of Polar's composer, laid out as Claude's is: add files
 * or photos (Ctrl+U), add a folder, the slash commands, and a submenu for what
 * extends Polar - connectors, skills and tools - that counts the connections
 * waiting on the reader. One menu instead of a row of loose buttons, so Chat
 * and Code offer the same things in the same place.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { POLAR_SETTINGS_PATH } from "@/lib/polar/settings-path";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { needsAttention } from "@/lib/polar/connectors/directory";
import { useChooseFiles } from "@/components/file-picker/use-choose-files";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FolderOpen, Paperclip, Plug, Plus, Sparkles, SquareSlash, Wrench } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger
} from "@polaris/ui";
import { PromptInputButton } from "@/components/polar/elements/prompt-input";

/** Files this composer takes, or why it takes none. */
export type PlusMenuAttach =
    | { readonly refusal: string }
    | {
          readonly accept: readonly string[];
          readonly disabled: boolean;
          readonly onFiles: (files: File[]) => void;
          readonly onFailed: (message: string) => void;
      };

/** Whether the shortcut is Ctrl+U (or Cmd+U on a Mac), and nothing else held. */
export function isAttachShortcut(event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}): boolean {
    return (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "u"
    );
}

/** How many of the reader's connectors cannot be used until they act, read
 *  when the menu opens; null when it could not be read. */
function useAttentionCount(open: boolean): number | null {
    const [count, setCount] = useState<number | null>(null);
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        fetch("/api/polar/connectors", { signal: controller.signal })
            .then((response) => (response.ok ? response.json() : null))
            .then((data: unknown) => {
                const rows = (data as { connectors?: unknown } | null)?.connectors;
                if (!Array.isArray(rows)) return;
                setCount(
                    rows.filter(
                        (row): row is Parameters<typeof needsAttention>[0] =>
                            typeof row === "object" && row !== null && needsAttention(row as never)
                    ).length
                );
            })
            .catch(() => undefined);
        return () => controller.abort();
    }, [open]);
    return count;
}

function Trailing({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <span className={cn("ms-auto shrink-0 ps-4 text-xs text-muted-foreground", className)}>
            {children}
        </span>
    );
}

export function ComposerPlusMenu({
    attach,
    attachId,
    slashable,
    onSlash,
    disabled = false,
    registerOpenFiles
}: {
    attach: PlusMenuAttach;
    /** The id the hidden attach button sits under, for a command that presses it. */
    attachId?: string;
    /** Whether the box is empty, so a "/" can open the commands without
     *  replacing a draft. */
    slashable: boolean;
    onSlash: () => void;
    disabled?: boolean;
    /** Hands the composer the file picker, for Ctrl+U. */
    registerOpenFiles?: (open: (() => void) | null) => void;
}) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const [choose, chooser] = useChooseFiles();
    const folder = useRef<HTMLInputElement | null>(null);
    const attention = useAttentionCount(open);
    const takes = "accept" in attach && !attach.disabled;

    const openFiles = useCallback(async () => {
        if (!("accept" in attach) || attach.disabled) return;
        const files = await choose({
            accept: attach.accept.join(","),
            multiple: true,
            title: t("plus.files"),
            onFailed: attach.onFailed
        });
        if (files.length > 0) attach.onFiles(files);
    }, [attach, choose, t]);

    useEffect(() => {
        registerOpenFiles?.(takes ? () => void openFiles() : null);
        return () => registerOpenFiles?.(null);
    }, [registerOpenFiles, openFiles, takes]);

    const refusal = "refusal" in attach ? attach.refusal : null;
    const settings = (section: string) => `${POLAR_SETTINGS_PATH}/${section}`;

    return (
        <>
            {chooser}
            <span id={attachId} className="contents">
                {/* What `/file` presses: the picker itself, not the menu. */}
                <button
                    type="button"
                    hidden
                    data-polar-attach
                    tabIndex={-1}
                    onClick={() => void openFiles()}
                />
            </span>
            <input
                ref={folder}
                type="file"
                hidden
                multiple
                // Not in React's typings; the browsers that matter all read it.
                {...{ webkitdirectory: "" }}
                onChange={(event) => {
                    const picked = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    if (picked.length > 0 && "onFiles" in attach) attach.onFiles(picked);
                }}
            />
            <DropdownMenu open={open} onOpenChange={setOpen}>
                <DropdownMenuTrigger asChild disabled={disabled}>
                    <PromptInputButton label={t("plus.open")} className="rounded-full">
                        <Plus />
                    </PromptInputButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-72 max-w-[calc(100vw-2rem)]">
                    <DropdownMenuItem
                        disabled={!takes}
                        onSelect={() => void openFiles()}
                        title={refusal ?? undefined}
                    >
                        <Paperclip />
                        <span className="min-w-0 truncate">{t("plus.files")}</span>
                        <Trailing>{refusal ? null : t("plus.filesKey")}</Trailing>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        disabled={!takes}
                        onSelect={() => folder.current?.click()}
                        title={refusal ?? undefined}
                    >
                        <FolderOpen />
                        <span className="min-w-0 truncate">{t("plus.folder")}</span>
                    </DropdownMenuItem>
                    {refusal ? (
                        <p className="px-2 pb-1 text-xs text-muted-foreground">{refusal}</p>
                    ) : null}
                    <DropdownMenuItem
                        disabled={!slashable}
                        onSelect={onSlash}
                        title={slashable ? undefined : t("plus.slashBusy")}
                    >
                        <SquareSlash />
                        <span className="min-w-0 truncate">{t("plus.slash")}</span>
                        <Trailing>{slashable ? "/" : t("plus.slashBusy")}</Trailing>
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <Plug />
                            <span className="min-w-0 truncate">{t("plus.plugins")}</span>
                            {attention ? (
                                <Trailing className="text-warning-ink">
                                    {t("plus.attention", { count: attention })}
                                </Trailing>
                            ) : null}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-64">
                            <DropdownMenuItem asChild>
                                <Link href={settings("connectors")}>
                                    <Plug />
                                    <span className="min-w-0 truncate">{t("plus.connectors")}</span>
                                    {attention ? (
                                        <Trailing className="text-warning-ink">
                                            {t("plus.attention", { count: attention })}
                                        </Trailing>
                                    ) : null}
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <Link href={settings("skills")}>
                                    <Sparkles />
                                    <span className="min-w-0 truncate">{t("plus.skills")}</span>
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <Link href={settings("tools")}>
                                    <Wrench />
                                    <span className="min-w-0 truncate">{t("plus.tools")}</span>
                                </Link>
                            </DropdownMenuItem>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}

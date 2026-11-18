"use client";

/**
 * What the sharer can do with the screen going out: stop, pick something else
 * without ending the stream, its frame rate and resolution, its sound, a
 * window of its own, how their own preview behaves, and reporting a problem.
 *
 * The rows only. The same rows are drawn by the share button's arrow, by the
 * narrow bar's "more" menu, and by right-clicking the sharer's own stream, so
 * they take the menu's parts (`kit`) rather than importing one menu's.
 */

import type { CallState } from "./use-call";
import { LOCAL_SCREEN_KEY } from "./call-media";
import { shareMenuRows } from "./call-share-menu";
import { canPopOut, closePopOut, popOut, usePoppedStream } from "./call-stream-audio";
import {
    STREAM_FRAME_RATES,
    STREAM_PRESETS,
    STREAM_RESOLUTIONS,
    modeOf,
    setStreamPrefs,
    useStreamPrefs,
    type StreamFrameRate,
    type StreamResolution,
    type StreamShape
} from "./stream-shape";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Check, Flag, MonitorUp, MonitorX, PictureInPicture2 } from "lucide-react";
import {
    Checkbox,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    cn
} from "@polaris/ui";

/** The parts of one kind of menu. */
export interface MenuKit {
    readonly Item: typeof DropdownMenuItem;
    readonly Label: typeof DropdownMenuLabel;
    readonly Separator: typeof DropdownMenuSeparator;
    readonly Sub: typeof DropdownMenuSub;
    readonly SubTrigger: typeof DropdownMenuSubTrigger;
    readonly SubContent: typeof DropdownMenuSubContent;
}

export const DROPDOWN_KIT: MenuKit = {
    Item: DropdownMenuItem,
    Label: DropdownMenuLabel,
    Separator: DropdownMenuSeparator,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent
};

export const CONTEXT_KIT: MenuKit = {
    Item: ContextMenuItem as unknown as typeof DropdownMenuItem,
    Label: ContextMenuLabel as unknown as typeof DropdownMenuLabel,
    Separator: ContextMenuSeparator,
    Sub: ContextMenuSub as unknown as typeof DropdownMenuSub,
    SubTrigger: ContextMenuSubTrigger as unknown as typeof DropdownMenuSubTrigger,
    SubContent: ContextMenuSubContent as unknown as typeof DropdownMenuSubContent
};

type T = NamespaceTranslator<"chat">;

export function resolutionLabel(t: T, resolution: StreamResolution): string {
    return resolution === "source"
        ? t("streamQuality.source")
        : t("streamQuality.lines", { lines: resolution });
}

/** "Gaming - Smoother video - 720p - 30 FPS", or the ladder's own word. */
export function streamSummary(t: T, shape: StreamShape | null): string {
    if (!shape) return t("callRoom.automatic");
    const mode = modeOf(shape);
    return [
        t(`streamQuality.modes.${mode}.name`),
        t(`streamQuality.modes.${mode}.hint`),
        resolutionLabel(t, shape.resolution),
        t("streamQuality.fps", { fps: shape.frameRate })
    ].join(" - ");
}

/** The shape after one of its two halves changed. Starting from the ladder,
 *  the half not chosen comes from the Gaming mode. */
export function reshape(
    shape: StreamShape | null,
    change: { frameRate?: StreamFrameRate; resolution?: StreamResolution }
): StreamShape {
    return { ...(shape ?? STREAM_PRESETS.gaming), ...change };
}

export function MenuRadio({
    kit,
    on,
    onPick,
    children
}: {
    kit: MenuKit;
    on: boolean;
    onPick: () => void;
    children: React.ReactNode;
}) {
    return (
        <kit.Item
            role="menuitemradio"
            aria-checked={on}
            onSelect={(event) => {
                // Left open, so the dot can be seen to move and the other
                // group reached next.
                event.preventDefault();
                onPick();
            }}
        >
            <Check className={cn("size-3.5 shrink-0", on ? "opacity-100" : "opacity-0")} />
            {children}
        </kit.Item>
    );
}

export function MenuToggle({
    kit,
    on,
    disabled,
    onToggle,
    children
}: {
    kit: MenuKit;
    on: boolean;
    disabled?: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}) {
    return (
        <kit.Item
            role="menuitemcheckbox"
            aria-checked={on}
            disabled={disabled}
            onSelect={(event) => {
                event.preventDefault();
                onToggle();
            }}
        >
            <Checkbox
                checked={on}
                disabled={disabled}
                readOnly
                tabIndex={-1}
                aria-hidden
                className="pointer-events-none"
            />
            <span className="flex min-w-0 flex-col">{children}</span>
        </kit.Item>
    );
}

export function ShareStreamItems({
    call,
    canShare,
    onReport,
    kit = DROPDOWN_KIT
}: {
    call: CallState;
    canShare: boolean;
    /** Opens the report dialog; the menu closes first. */
    onReport: () => void;
    kit?: MenuKit;
}) {
    const t = useTranslations("chat");
    const prefs = useStreamPrefs();
    const popped = usePoppedStream() === LOCAL_SCREEN_KEY;
    const rows = shareMenuRows({
        canShare,
        hasAudio: call.shareAudio.has,
        audioOn: call.shareAudio.on,
        changing: call.changingShare
    });
    const shape = prefs.shape;
    const showing = streamSummary(t, shape);

    return (
        <>
            <kit.Item variant="danger" onSelect={call.toggleShare}>
                <MonitorX className="size-4 shrink-0" />
                {t("callRoom.shareMenu.stop")}
            </kit.Item>
            <kit.Item disabled={rows.change.disabled} onSelect={call.changeShare}>
                <MonitorUp className="size-4 shrink-0" />
                {t("callRoom.shareMenu.change")}
            </kit.Item>
            <kit.Sub>
                <kit.SubTrigger>
                    <span className="flex min-w-0 flex-col">
                        <span>{t("callRoom.shareMenu.quality")}</span>
                        <span className="truncate text-xs text-muted-foreground" title={showing}>
                            {showing}
                        </span>
                    </span>
                </kit.SubTrigger>
                <kit.SubContent className="w-60">
                    <MenuRadio
                        kit={kit}
                        on={shape === null}
                        onPick={() => call.setScreenQuality("auto")}
                    >
                        <span className="flex min-w-0 flex-col">
                            <span>{t("callRoom.automatic")}</span>
                            <span className="text-xs text-muted-foreground">
                                {t("callRoom.dropsWhenTheConnectionStruggles")}
                            </span>
                        </span>
                    </MenuRadio>
                    <kit.Separator />
                    <kit.Label>{t("streamQuality.frameRate")}</kit.Label>
                    {STREAM_FRAME_RATES.map((frameRate) => (
                        <MenuRadio
                            key={frameRate}
                            kit={kit}
                            on={shape?.frameRate === frameRate}
                            onPick={() => setStreamPrefs({ shape: reshape(shape, { frameRate }) })}
                        >
                            {t("streamQuality.fps", { fps: frameRate })}
                        </MenuRadio>
                    ))}
                    <kit.Separator />
                    <kit.Label>{t("streamQuality.resolution")}</kit.Label>
                    {STREAM_RESOLUTIONS.map((resolution) => (
                        <MenuRadio
                            key={resolution}
                            kit={kit}
                            on={shape?.resolution === resolution}
                            onPick={() => setStreamPrefs({ shape: reshape(shape, { resolution }) })}
                        >
                            {resolutionLabel(t, resolution)}
                        </MenuRadio>
                    ))}
                </kit.SubContent>
            </kit.Sub>
            <kit.Separator />
            <MenuToggle
                kit={kit}
                on={rows.audio.checked}
                disabled={rows.audio.disabled}
                onToggle={() => call.setShareAudio(!rows.audio.checked)}
            >
                <span>{t("callRoom.shareMenu.audio")}</span>
                {rows.audio.reason === "no-sound" && (
                    <span className="text-xs text-muted-foreground">
                        {t("callRoom.shareMenu.noSound")}
                    </span>
                )}
            </MenuToggle>
            {canPopOut() && call.localScreen && (
                <kit.Item
                    onSelect={() => {
                        if (popped) closePopOut();
                        else if (call.localScreen) void popOut(LOCAL_SCREEN_KEY, call.localScreen);
                    }}
                >
                    <PictureInPicture2 className="size-4 shrink-0" />
                    {popped ? t("callMenus.closePopOut") : t("callRoom.shareMenu.popOut")}
                </kit.Item>
            )}
            <kit.Sub>
                <kit.SubTrigger>{t("callRoom.shareMenu.more")}</kit.SubTrigger>
                <kit.SubContent className="w-64">
                    <MenuToggle
                        kit={kit}
                        on={prefs.showOwn}
                        onToggle={() => setStreamPrefs({ showOwn: !prefs.showOwn })}
                    >
                        {t("callRoom.shareMenu.showOwn")}
                    </MenuToggle>
                    <MenuToggle
                        kit={kit}
                        on={prefs.pauseUnfocused}
                        disabled={!prefs.showOwn}
                        onToggle={() => setStreamPrefs({ pauseUnfocused: !prefs.pauseUnfocused })}
                    >
                        {t("callRoom.shareMenu.pauseUnfocused")}
                    </MenuToggle>
                </kit.SubContent>
            </kit.Sub>
            <kit.Separator />
            <kit.Item onSelect={onReport}>
                <Flag className="size-4 shrink-0" />
                {t("callRoom.shareMenu.report")}
            </kit.Item>
        </>
    );
}

"use client";

/**
 * What the share button offers while a screen is going out: stop, pick
 * something else to share without ending the stream, how much picture, and
 * whether its sound goes with it. The rows only - the menu around them is the
 * caller's, so the call bar and the narrow bar's "more" menu draw the same ones.
 */

import type { CallState } from "./use-call";
import { shareMenuRows } from "./call-share-menu";
import { Check, MonitorUp, MonitorX } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { LEVELS, SCREEN_LADDER, type CallQuality } from "./call-quality";
import {
    Checkbox,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    cn
} from "@polaris/ui";

export function ShareStreamItems({ call, canShare }: { call: CallState; canShare: boolean }) {
    const t = useTranslations("chat");
    const rows = shareMenuRows({
        canShare,
        hasAudio: call.shareAudio.has,
        audioOn: call.shareAudio.on,
        changing: call.changingShare
    });
    const rung = SCREEN_LADDER.rungs[call.screenLevel];
    const showing =
        call.screenQuality === "auto"
            ? t("callRoom.automatic")
            : `${t(rung.label)} - ${rung.detailKey ? t(rung.detailKey) : rung.detail}`;
    const choices: readonly CallQuality[] = ["auto", ...LEVELS];

    return (
        <>
            <DropdownMenuItem variant="danger" onSelect={call.toggleShare}>
                <MonitorX className="size-4 shrink-0" />
                {t("callRoom.shareMenu.stop")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={rows.change.disabled} onSelect={call.changeShare}>
                <MonitorUp className="size-4 shrink-0" />
                {t("callRoom.shareMenu.change")}
            </DropdownMenuItem>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <span className="flex min-w-0 flex-col">
                        <span>{t("callRoom.shareMenu.quality")}</span>
                        <span className="truncate text-xs text-muted-foreground" title={showing}>
                            {showing}
                        </span>
                    </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-w-72">
                    {choices.map((choice) => {
                        const option = choice === "auto" ? null : SCREEN_LADDER.rungs[choice];
                        return (
                            <DropdownMenuItem
                                key={choice}
                                role="menuitemradio"
                                aria-checked={call.screenQuality === choice}
                                onSelect={() => call.setScreenQuality(choice)}
                            >
                                <Check
                                    className={cn(
                                        "size-3.5 shrink-0",
                                        call.screenQuality === choice ? "opacity-100" : "opacity-0"
                                    )}
                                />
                                <span className="flex min-w-0 flex-col">
                                    <span>
                                        {option ? t(option.label) : t("callRoom.automatic")}
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground">
                                        {option
                                            ? option.detailKey
                                                ? t(option.detailKey)
                                                : option.detail
                                            : t("callRoom.dropsWhenTheConnectionStruggles")}
                                    </span>
                                </span>
                            </DropdownMenuItem>
                        );
                    })}
                </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
                role="menuitemcheckbox"
                aria-checked={rows.audio.checked}
                disabled={rows.audio.disabled}
                onSelect={(event) => {
                    // Left open, so the box can be seen to change.
                    event.preventDefault();
                    call.setShareAudio(!rows.audio.checked);
                }}
            >
                <Checkbox
                    checked={rows.audio.checked}
                    disabled={rows.audio.disabled}
                    readOnly
                    tabIndex={-1}
                    aria-hidden
                    className="pointer-events-none"
                />
                <span className="flex min-w-0 flex-col">
                    <span>{t("callRoom.shareMenu.audio")}</span>
                    {rows.audio.reason === "no-sound" && (
                        <span className="text-xs text-muted-foreground">
                            {t("callRoom.shareMenu.noSound")}
                        </span>
                    )}
                </span>
            </DropdownMenuItem>
        </>
    );
}

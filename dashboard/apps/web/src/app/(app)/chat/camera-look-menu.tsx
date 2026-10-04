"use client";

/**
 * Light, colour and framing, as the camera menu in a call offers them.
 *
 * Three submenus rather than three lists: the camera menu already holds the
 * devices, the quality bar and the backgrounds, and eleven more rows under them
 * would push the backgrounds off a phone's screen. Each submenu is one choice,
 * ticked where it stands.
 */

import { Check } from "lucide-react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    cn
} from "@polaris/ui";
import {
    FRAME_CHOICES,
    LIGHT_CHOICES,
    STYLE_CHOICES,
    type CameraLook
} from "./camera-look";

export function CameraLookMenu({
    look,
    onLook
}: {
    look: CameraLook;
    onLook: (patch: Partial<CameraLook>) => void;
}) {
    const t = useTranslations("chat");
    return (
        <>
            <DropdownMenuLabel>{t("callSettings.look.title")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <LookSub
                label={t("callSettings.look.light.title")}
                choices={LIGHT_CHOICES}
                value={look.light}
                onPick={(light) => onLook({ light })}
            />
            <LookSub
                label={t("callSettings.look.style.title")}
                choices={STYLE_CHOICES}
                value={look.style}
                onPick={(style) => onLook({ style })}
            />
            <LookSub
                label={t("callSettings.look.frame.title")}
                choices={FRAME_CHOICES}
                value={look.frame}
                onPick={(frame) => onLook({ frame })}
            />
        </>
    );
}

function LookSub<T extends string>({
    label,
    choices,
    value,
    onPick
}: {
    label: string;
    choices: readonly { value: T; label: NamespaceKey<"chat"> }[];
    value: T;
    onPick: (value: T) => void;
}) {
    const t = useTranslations("chat");
    const current = choices.find((choice) => choice.value === value);
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                    <span className="truncate" title={label}>{label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                        {current ? t(current.label) : null}
                    </span>
                </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                {choices.map((choice) => (
                    <DropdownMenuItem key={choice.value} onSelect={() => onPick(choice.value)}>
                        <Check
                            className={cn(
                                "size-3.5 shrink-0",
                                value === choice.value ? "opacity-100" : "opacity-0"
                            )}
                        />
                        {t(choice.label)}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

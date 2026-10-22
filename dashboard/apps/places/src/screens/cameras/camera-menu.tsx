"use client";

/**
 * What managing one camera offers, behind one button.
 *
 * On a tile it is everything - there is no room for a row of icons under a
 * picture - and in the list, where the common actions already sit as icons, it
 * holds the two switches that have no icon of their own: on or off, and what it
 * keeps.
 */

import { usePlacesT } from "../use-places-t";
import type { PlacesKey } from "../../../messages";
import type { CameraView } from "../../lib/cameras";
import { RECORDING_MODES } from "../../lib/schemas";
import { Check, MoreHorizontal, Pencil, Power, Shapes, Share2, Trash2 } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuLabel,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger
} from "@polaris/ui";

export interface CameraManagement {
    edit: (camera: CameraView) => void;
    drawAreas: (camera: CameraView) => void;
    share: (camera: CameraView) => void;
    remove: (camera: CameraView) => void;
    switchCamera: (
        camera: CameraView,
        change: { enabled?: boolean; recording?: (typeof RECORDING_MODES)[number] }
    ) => void;
}

export function CameraMenu({
    camera,
    manage,
    full
}: {
    camera: CameraView;
    manage: CameraManagement;
    /** Whether to carry the actions the list already shows as icons. */
    full: boolean;
}) {
    const t = usePlacesT();
    const label = t("cameras.moreFor", { name: camera.name });
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={label} title={label}>
                    <MoreHorizontal className="size-4 shrink-0" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                    <span className="block max-w-56 truncate" title={camera.name}>
                        {camera.name}
                    </span>
                </DropdownMenuLabel>
                {full ? (
                    <>
                        <DropdownMenuItem onSelect={() => manage.edit(camera)}>
                            <Pencil className="size-4 shrink-0" />
                            {t("cameras.renameAndChange")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => manage.drawAreas(camera)}>
                            <Shapes className="size-4 shrink-0" />
                            {t("cameras.drawAreas")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => manage.share(camera)}>
                            <Share2 className="size-4 shrink-0" />
                            {t("cameras.share")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                    </>
                ) : null}
                <DropdownMenuItem
                    onSelect={() => manage.switchCamera(camera, { enabled: !camera.enabled })}
                >
                    <Power className="size-4 shrink-0" />
                    {camera.enabled ? t("cameras.switchOff") : t("cameras.switchOn")}
                </DropdownMenuItem>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{t("cameras.whatItKeeps")}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        {RECORDING_MODES.map((mode) => (
                            <DropdownMenuItem
                                key={mode}
                                aria-checked={camera.recording === mode}
                                role="menuitemradio"
                                onSelect={() =>
                                    camera.recording !== mode &&
                                    manage.switchCamera(camera, { recording: mode })
                                }
                            >
                                <Check
                                    className={
                                        camera.recording === mode
                                            ? "size-4 shrink-0"
                                            : "size-4 shrink-0 opacity-0"
                                    }
                                />
                                {t(`cameras.keeps.${mode}` as PlacesKey)}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                {full ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="danger" onSelect={() => manage.remove(camera)}>
                            <Trash2 className="size-4 shrink-0" />
                            {t("cameras.remove")}
                        </DropdownMenuItem>
                    </>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

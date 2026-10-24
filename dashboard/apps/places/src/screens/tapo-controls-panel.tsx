"use client";

/**
 * A Tapo camera's own controls, over its picture: siren, positions, status
 * light, image flip, night vision, motion detection and restart.
 *
 * Read from the camera when the panel is opened, never before - asking means
 * signing in to the camera, and nobody asked yet. Only what the camera answered
 * for is drawn. A switch moves at once and goes back if the camera refused.
 */

import * as actions from "./actions";
import { usePlacesT } from "./use-places-t";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Siren } from "lucide-react";
import { afterCommand, type TapoCommand, type TapoControls } from "../lib/camera-control-kinds";
import { Button, ConfirmDeleteDialog, SegmentedControl, Switch, cn, useToast } from "@polaris/ui";

export function TapoControlsPanel({
    cameraId,
    cameraName,
    onControls
}: {
    cameraId: string;
    cameraName: string;
    /** Told what the camera answered for, so the picture can draw its arrows. */
    onControls?: (controls: TapoControls) => void;
}) {
    const t = usePlacesT();
    const toast = useToast();
    const [controls, setControls] = useState<TapoControls | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<TapoCommand["kind"] | null>(null);
    const [restarting, setRestarting] = useState(false);

    const load = useCallback(async () => {
        setError(null);
        const result = await actions.tapoControlsAction(cameraId).catch(() => null);
        if (!result?.controls) {
            setError(result?.error ?? t("tapo.failed"));
            return;
        }
        setControls(result.controls);
        onControls?.(result.controls);
    }, [cameraId, onControls, t]);

    useEffect(() => {
        void load();
    }, [load]);

    const send = async (command: TapoCommand) => {
        if (!controls || busy) return;
        const before = controls;
        setBusy(command.kind);
        setControls(afterCommand(controls, command));
        const result = await actions.tapoCommandAction(cameraId, command).catch(() => null);
        setBusy(null);
        if (!result?.controls) {
            setControls(before);
            toast.show({
                key: `places-tapo-${cameraId}`,
                title: result?.error ?? t("tapo.failed")
            });
            return;
        }
        setControls(result.controls);
        if (command.kind === "reboot")
            toast.show({ key: `places-tapo-${cameraId}`, title: t("tapo.restarting") });
    };

    const panel = "w-full space-y-3 text-xs text-white";
    if (error)
        return (
            <div className={panel}>
                <p className="text-white/80">{error}</p>
                <Button size="sm" variant="secondary" onClick={() => void load()}>
                    {t("tapo.retry")}
                </Button>
            </div>
        );
    if (!controls)
        return (
            <div className={cn(panel, "flex items-center gap-2 text-white/70")}>
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span className="min-w-0 truncate">{t("tapo.reading")}</span>
            </div>
        );

    const nothing =
        !controls.siren &&
        !controls.presets?.length &&
        controls.led === null &&
        controls.flip === null &&
        !controls.night &&
        !controls.motion &&
        !controls.reboot;

    return (
        <div className={panel}>
            {nothing ? <p className="text-white/70">{t("tapo.none")}</p> : null}

            {controls.siren ? (
                <Row label={t("tapo.siren")}>
                    {controls.siren === "status" ? (
                        <Button
                            size="sm"
                            variant={controls.sirenOn ? "danger" : "secondary"}
                            disabled={busy === "siren"}
                            onClick={() => void send({ kind: "siren", on: !controls.sirenOn })}
                        >
                            <Siren className="size-3.5 shrink-0" />
                            {controls.sirenOn ? t("tapo.sirenStop") : t("tapo.sirenStart")}
                        </Button>
                    ) : (
                        <div className="flex flex-wrap gap-1">
                            <Button
                                size="sm"
                                variant="danger"
                                disabled={busy === "siren"}
                                onClick={() => void send({ kind: "siren", on: true })}
                            >
                                <Siren className="size-3.5 shrink-0" />
                                {t("tapo.sirenStart")}
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy === "siren"}
                                onClick={() => void send({ kind: "siren", on: false })}
                            >
                                {t("tapo.sirenStop")}
                            </Button>
                        </div>
                    )}
                </Row>
            ) : null}

            {controls.presets?.length ? (
                <div className="space-y-1">
                    <p className="text-white/70">{t("tapo.positions")}</p>
                    <div className="flex flex-wrap gap-1">
                        {controls.presets.map((preset) => (
                            <Button
                                key={preset.id}
                                size="sm"
                                variant="secondary"
                                className="max-w-full"
                                title={preset.name}
                                disabled={busy === "preset"}
                                onClick={() => void send({ kind: "preset", id: preset.id })}
                            >
                                <span className="min-w-0 truncate">{preset.name}</span>
                            </Button>
                        ))}
                    </div>
                </div>
            ) : null}

            {controls.led !== null ? (
                <Row label={t("tapo.led")}>
                    <Switch
                        aria-label={t("tapo.led")}
                        checked={controls.led}
                        disabled={busy === "led"}
                        onChange={(on) => void send({ kind: "led", on })}
                    />
                </Row>
            ) : null}

            {controls.flip !== null ? (
                <Row label={t("tapo.flip")}>
                    <Switch
                        aria-label={t("tapo.flip")}
                        checked={controls.flip}
                        disabled={busy === "flip"}
                        onChange={(on) => void send({ kind: "flip", on })}
                    />
                </Row>
            ) : null}

            {controls.night ? (
                <div className="space-y-1">
                    <p className="text-white/70">{t("tapo.night")}</p>
                    <SegmentedControl
                        size="sm"
                        value={controls.night.mode}
                        onValueChange={(mode) => void send({ kind: "night", mode })}
                        options={controls.night.modes.map((mode) => ({
                            value: mode,
                            label: t(`tapo.nightModes.${mode}`),
                            disabled: busy === "night"
                        }))}
                    />
                </div>
            ) : null}

            {controls.motion ? (
                <div className="space-y-1">
                    <Row label={t("tapo.motion")}>
                        <Switch
                            aria-label={t("tapo.motion")}
                            checked={controls.motion.enabled}
                            disabled={busy === "motion"}
                            onChange={(enabled) =>
                                controls.motion &&
                                void send({
                                    kind: "motion",
                                    enabled,
                                    sensitivity: controls.motion.sensitivity
                                })
                            }
                        />
                    </Row>
                    {controls.motion.enabled ? (
                        <SegmentedControl
                            size="sm"
                            value={controls.motion.sensitivity}
                            onValueChange={(sensitivity) =>
                                void send({ kind: "motion", enabled: true, sensitivity })
                            }
                            options={(["low", "medium", "high"] as const).map((level) => ({
                                value: level,
                                label: t(`tapo.sensitivity.${level}`),
                                disabled: busy === "motion"
                            }))}
                        />
                    ) : null}
                </div>
            ) : null}

            {controls.reboot ? (
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === "reboot"}
                    onClick={() => setRestarting(true)}
                >
                    <RotateCcw className="size-3.5 shrink-0" />
                    {t("tapo.restart")}
                </Button>
            ) : null}

            <ConfirmDeleteDialog
                open={restarting}
                onOpenChange={setRestarting}
                name={cameraName}
                kind={t("tapo.cameraKind")}
                requireTyping={false}
                title={t("tapo.restartTitle")}
                question={t("tapo.restartQuestion", { name: cameraName })}
                confirmLabel={t("tapo.restart")}
                onConfirm={() => {
                    setRestarting(false);
                    void send({ kind: "reboot" });
                }}
            />
        </div>
    );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate" title={label}>
                {label}
            </span>
            <div className="shrink-0">{children}</div>
        </div>
    );
}

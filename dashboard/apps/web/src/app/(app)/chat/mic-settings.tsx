"use client";

/**
 * Everything about this machine's microphone, in one place.
 *
 * Which one, how much is done to what it hears, and how loud it goes out. The
 * three were in three places - the device in the composer's own chevron, the
 * cleanup only inside a call, the level nowhere at all - and they are one
 * decision made once about one microphone: somebody told they are quiet, or that
 * their keyboard is deafening, has to be able to answer without knowing which
 * screen Polaris keeps that particular knob on.
 *
 * All three are per browser and shared with calls and voice messages. Picking a
 * good headset for a call and then recording a clip through the laptop lid is
 * exactly the surprise this prevents, and it only turns up in the recording -
 * by which time it is somebody else's problem.
 */

import { cn } from "@polaris/ui";
import { Check } from "lucide-react";
import { useMicrophones } from "./mic-device";
import { useMicGain, GAIN_MAX, GAIN_MIN } from "./mic-gain";
import { NOISE_LEVELS, useMicCleanup } from "./mic-cleanup";

/** The level as a percentage, which is the only way anybody reads a volume. */
function percent(gain: number): string {
    return `${Math.round(gain * 100)}%`;
}

export function MicSettings({ className }: { className?: string }) {
    const { devices, chosenId, choose } = useMicrophones();
    const [cleanup, setCleanup] = useMicCleanup();
    const [gain, setGain] = useMicGain();

    return (
        <div className={cn("flex flex-col gap-3 text-xs", className)}>
            {devices.length > 1 && (
                <div className="flex flex-col gap-1">
                    <p className="font-medium text-foreground-subtle">Microphone</p>
                    {devices.map((device) => (
                        <button
                            key={device.id}
                            type="button"
                            onClick={() => choose(device.id)}
                            className="flex items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-muted"
                        >
                            <Check
                                className={cn(
                                    "size-3.5 shrink-0",
                                    device.id === chosenId ? "opacity-100" : "opacity-0"
                                )}
                            />
                            <span className="truncate" title={device.label}>
                                {device.label}
                            </span>
                        </button>
                    ))}
                </div>
            )}

            <div className="flex flex-col gap-1">
                <p className="font-medium text-foreground-subtle">Background noise</p>
                {NOISE_LEVELS.map((level) => (
                    <button
                        key={level.value}
                        type="button"
                        onClick={() => setCleanup(level.value)}
                        title={level.help}
                        className="flex items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-muted"
                    >
                        <Check
                            className={cn(
                                "size-3.5 shrink-0",
                                level.value === cleanup ? "opacity-100" : "opacity-0"
                            )}
                        />
                        <span className="truncate" title={level.label}>{level.label}</span>
                    </button>
                ))}
            </div>

            <div className="flex flex-col gap-1">
                <span className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground-subtle">Microphone volume</span>
                    <span className="tabular-nums text-muted-foreground">{percent(gain)}</span>
                </span>
                <input
                    type="range"
                    min={GAIN_MIN * 100}
                    max={GAIN_MAX * 100}
                    step={5}
                    value={Math.round(gain * 100)}
                    aria-label="Microphone volume"
                    onChange={(event) => setGain(Number(event.target.value) / 100)}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary"
                />
                <p className="text-muted-foreground">
                    How loud you go out. Turn it up if people say you are quiet.
                </p>
            </div>
        </div>
    );
}

"use client";

/**
 * The microphone and the camera on this machine, and everything around them.
 *
 * It exists because of where these answers used to live: the microphone in a
 * chevron inside the composer, the noise handling only once you were already in
 * a call, the camera nowhere at all. Somebody told they sound terrible had to
 * find the screen Polaris happened to keep that particular knob on - and the one
 * question they actually wanted answered, "does it work", could only be answered
 * by joining a call and asking somebody.
 *
 * So both devices are tested here. The microphone draws its own level while
 * somebody talks into it, which is the only way a threshold can be set and the
 * only honest answer to "is it picking me up". The camera shows itself. Neither
 * test touches a call, and neither runs unless somebody pressed it: a settings
 * screen that holds the microphone open is one nobody leaves open.
 *
 * Everything here is per browser. A headset is plugged into a machine, not into
 * an account, and the laptop in the kitchen and the desk with the headset want
 * different answers.
 */

import { refused } from "@/app/(app)/chat/call-media";
import { Camera, Loader2, Mic, Square } from "lucide-react";
import { useCameras } from "@/app/(app)/chat/camera-device";
import { useMicrophones } from "@/app/(app)/chat/mic-device";
import { useCallback, useEffect, useRef, useState } from "react";
import { measureVoice, speaking } from "@/app/(app)/chat/voice-level";
import { Button, Card, CardBody, Select, Switch, cn } from "@polaris/ui";
import { useMicGain, GAIN_MAX, GAIN_MIN } from "@/app/(app)/chat/mic-gain";
import { NOISE_LEVELS, micConstraints, useMicCleanup } from "@/app/(app)/chat/mic-cleanup";
import {
    INPUT_MODES,
    INPUT_MODE_LABELS,
    INPUT_MODE_NOTES,
    useVoiceSettings,
    type InputMode,
    type VoiceSettings
} from "@/app/(app)/chat/voice-settings";

/** What every card here is handed: the settings, and the one way to change one. */
type Change = (next: Partial<VoiceSettings>) => void;

/** The level as a percentage, which is the only way anybody reads a volume. */
function percent(gain: number): string {
    return `${Math.round(gain * 100)}%`;
}

/** A key press as somebody would write it down. The code is what is stored;
 *  this is what the button says. */
function keyName(code: string): string {
    if (code === "Space") return "Space";
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) return `Numpad ${code.slice(6)}`;
    if (code.startsWith("Arrow")) return `${code.slice(5)} arrow`;
    return code;
}

export function DevicesView() {
    const [voice, setVoice] = useVoiceSettings();

    return (
        <div className="flex flex-col gap-4">
            <MicrophoneCard
                threshold={voice.activityThreshold}
                showThreshold={voice.inputMode === "activity"}
            />
            <CameraCard />
            <InputModeCard voice={voice} setVoice={setVoice} />
            <AdvancedCard voice={voice} setVoice={setVoice} />
        </div>
    );
}

/** Which microphone, how much is done to it, how loud it goes out - and whether
 *  it is working at all. */
function MicrophoneCard({ threshold, showThreshold }: { threshold: number; showThreshold: boolean }) {
    const { devices, chosenId, choose } = useMicrophones();
    const [cleanup, setCleanup] = useMicCleanup();
    const [gain, setGain] = useMicGain();
    const [testing, setTesting] = useState(false);
    const [level, setLevel] = useState(0);
    const [error, setError] = useState("");
    const stream = useRef<MediaStream | null>(null);
    const reading = useRef<ReturnType<typeof setInterval> | null>(null);

    const stop = useCallback(() => {
        if (reading.current) clearInterval(reading.current);
        reading.current = null;
        for (const track of stream.current?.getTracks() ?? []) track.stop();
        stream.current = null;
        setTesting(false);
        setLevel(0);
    }, []);

    // Never left running. A tab closed on an open microphone is a light that
    // stays on, and this is a screen somebody opens and wanders away from.
    useEffect(() => stop, [stop]);

    const start = async () => {
        setError("");
        try {
            // The same constraints a call opens with, so what is measured here
            // is what the room will hear. A test through a different chain is a
            // test of something else.
            const opened = await navigator.mediaDevices.getUserMedia({
                audio: micConstraints(chosenId ?? undefined)
            });
            stream.current = opened;
            const track = opened.getAudioTracks()[0] ?? null;
            const meter = track ? measureVoice(track) : null;
            if (!meter) {
                stop();
                setError("This browser will not measure sound.");
                return;
            }
            setTesting(true);
            reading.current = setInterval(() => {
                if (!stream.current) return;
                setLevel(meter.read());
            }, 60);
        } catch (caught) {
            setError(refused(caught, "microphone"));
            stop();
        }
    };

    const open = speaking(level, threshold, false);

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="flex items-center gap-1.5 text-sm font-medium">
                        <Mic className="size-4 shrink-0 text-muted-foreground" />
                        Microphone
                    </h2>
                    <Button
                        size="sm"
                        variant={testing ? "secondary" : "outline"}
                        onClick={() => (testing ? stop() : void start())}
                    >
                        {testing ? (
                            <>
                                <Square className="size-3.5 shrink-0" />
                                Stop
                            </>
                        ) : (
                            "Test it"
                        )}
                    </Button>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                    Which one
                    <Select
                        value={chosenId ?? ""}
                        onValueChange={(value) => choose(value)}
                        aria-label="Microphone"
                        options={
                            devices.length > 0
                                ? devices.map((device) => ({ value: device.id, label: device.label }))
                                : [{ value: "", label: "Press Test it to see what is here" }]
                        }
                    />
                    <span className="text-xs text-muted-foreground">
                        The names only appear once a microphone has been allowed once, which the test does.
                    </span>
                </label>

                <div className="flex flex-col gap-1.5">
                    <span className="text-sm">Level</span>
                    {/* Drawn whether or not the test is running: an empty bar is
                        what says the test is the thing that fills it. */}
                    <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                            className={cn(
                                "h-full rounded-full transition-[width] duration-75",
                                open ? "bg-success" : "bg-primary"
                            )}
                            style={{ width: `${level}%` }}
                        />
                        {showThreshold ? (
                            <span
                                aria-hidden
                                title="Anything past this counts as you speaking"
                                className="absolute inset-y-0 w-0.5 bg-foreground/60"
                                style={{ left: `${threshold}%` }}
                            />
                        ) : null}
                    </div>
                    <span className="text-xs text-muted-foreground">
                        {testing
                            ? "Say something. The bar should move."
                            : "Press Test it and talk - this is what the room hears."}
                    </span>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                    Background noise
                    <Select
                        value={cleanup}
                        onValueChange={(value) => setCleanup(value as typeof cleanup)}
                        aria-label="Background noise"
                        options={NOISE_LEVELS.map((entry) => ({ value: entry.value, label: entry.label }))}
                    />
                    <span className="text-xs text-muted-foreground">
                        {NOISE_LEVELS.find((entry) => entry.value === cleanup)?.help ?? ""}
                    </span>
                </label>

                <div className="flex flex-col gap-1">
                    <span className="flex items-center justify-between gap-2 text-sm">
                        Volume
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
                        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                    />
                    <span className="text-xs text-muted-foreground">
                        How loud you go out. Turn it up if people say you are quiet.
                    </span>
                </div>

                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

/** Which camera, and what it is pointing at. */
function CameraCard() {
    const { devices, chosenId, choose } = useCameras();
    const [showing, setShowing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const video = useRef<HTMLVideoElement>(null);
    const stream = useRef<MediaStream | null>(null);

    const stop = useCallback(() => {
        for (const track of stream.current?.getTracks() ?? []) track.stop();
        stream.current = null;
        if (video.current) video.current.srcObject = null;
        setShowing(false);
    }, []);

    useEffect(() => stop, [stop]);

    const start = async () => {
        setError("");
        setBusy(true);
        try {
            const opened = await navigator.mediaDevices.getUserMedia({
                video: chosenId ? { deviceId: { exact: chosenId } } : true
            });
            stream.current = opened;
            setShowing(true);
            if (video.current) {
                video.current.srcObject = opened;
                await video.current.play().catch(() => undefined);
            }
        } catch (caught) {
            setError(refused(caught, "camera"));
            stop();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="flex items-center gap-1.5 text-sm font-medium">
                        <Camera className="size-4 shrink-0 text-muted-foreground" />
                        Camera
                    </h2>
                    <Button
                        size="sm"
                        variant={showing ? "secondary" : "outline"}
                        disabled={busy}
                        onClick={() => (showing ? stop() : void start())}
                    >
                        {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : null}
                        {showing ? "Stop" : "Show me"}
                    </Button>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                    Which one
                    <Select
                        value={chosenId ?? ""}
                        onValueChange={(value) => choose(value || null)}
                        aria-label="Camera"
                        options={
                            devices.length > 0
                                ? devices.map((device) => ({ value: device.id, label: device.label }))
                                : [{ value: "", label: "Press Show me to see what is here" }]
                        }
                    />
                </label>

                {/* Mirrored, because a preview of yourself that is not is a
                    preview people think is broken. What goes out is not
                    mirrored, and that is not this. */}
                <video
                    ref={video}
                    playsInline
                    muted
                    className={cn(
                        "aspect-video w-full -scale-x-100 rounded-lg bg-muted object-cover",
                        !showing && "hidden"
                    )}
                />
                {!showing ? (
                    <p className="text-xs text-muted-foreground">
                        Nothing is opened until you press it, and it closes when you leave this screen.
                    </p>
                ) : null}

                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

/** How the microphone decides whether it is sending. */
function InputModeCard({ voice, setVoice }: { voice: VoiceSettings; setVoice: Change }) {
    const [listening, setListening] = useState(false);

    // Captured on the window while the button is armed, in the capture phase, so
    // a key the field under it would have swallowed is still recordable.
    useEffect(() => {
        if (!listening) return;
        const down = (event: KeyboardEvent) => {
            event.preventDefault();
            if (event.code === "Escape") {
                setListening(false);
                return;
            }
            setVoice({ pttKey: event.code });
            setListening(false);
        };
        window.addEventListener("keydown", down, true);
        return () => window.removeEventListener("keydown", down, true);
    }, [listening, setVoice]);

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <h2 className="text-sm font-medium">Input</h2>

                <label className="flex flex-col gap-1 text-sm">
                    When your microphone is sending
                    <Select
                        value={voice.inputMode}
                        onValueChange={(value) => setVoice({ inputMode: value as InputMode })}
                        aria-label="Input mode"
                        options={INPUT_MODES.map((mode) => ({ value: mode, label: INPUT_MODE_LABELS[mode] }))}
                    />
                    <span className="text-xs text-muted-foreground">{INPUT_MODE_NOTES[voice.inputMode]}</span>
                </label>

                {voice.inputMode === "ptt" ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm">Key</span>
                        <Button
                            size="sm"
                            variant={listening ? "secondary" : "outline"}
                            onClick={() => setListening(true)}
                        >
                            {listening ? "Press a key..." : keyName(voice.pttKey)}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            Held down to talk. It stands down while you are typing.
                        </span>
                    </div>
                ) : null}

                {voice.inputMode === "activity" ? (
                    <div className="flex flex-col gap-1">
                        <span className="flex items-center justify-between gap-2 text-sm">
                            How loud counts as talking
                            <span className="tabular-nums text-muted-foreground">
                                {voice.activityThreshold}
                            </span>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={voice.activityThreshold}
                            aria-label="Voice activity threshold"
                            onChange={(event) => setVoice({ activityThreshold: Number(event.target.value) })}
                            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                        />
                        <span className="text-xs text-muted-foreground">
                            Test the microphone above while you set this: the mark on the bar is where it
                            opens, and the bar turns green past it.
                        </span>
                    </div>
                ) : null}

                {voice.inputMode !== "open" ? (
                    <div className="flex flex-col gap-1">
                        <span className="flex items-center justify-between gap-2 text-sm">
                            Stay open after you stop
                            <span className="tabular-nums text-muted-foreground">{voice.pttReleaseMs} ms</span>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={1000}
                            step={50}
                            value={voice.pttReleaseMs}
                            aria-label="Release delay"
                            onChange={(event) => setVoice({ pttReleaseMs: Number(event.target.value) })}
                            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                        />
                        <span className="text-xs text-muted-foreground">
                            Zero cuts the last syllable off, and everybody hears it.
                        </span>
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}

/** The things somebody only comes looking for when something is wrong. */
function AdvancedCard({ voice, setVoice }: { voice: VoiceSettings; setVoice: Change }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">Advanced</h2>
                    <p className="text-xs text-muted-foreground">
                        Leave these alone unless something is wrong. Each one is set to what Polaris did
                        before this screen existed.
                    </p>
                </div>

                <Toggle
                    label="Automatic gain control"
                    note="Lets the browser even out how loud you are. Turn it off if your level is pumped up and down between sentences."
                    checked={voice.autoGainControl}
                    onChange={(next) => setVoice({ autoGainControl: next })}
                />
                <Toggle
                    label="Better voice detection"
                    note="Decides whether you are talking from the cleaned-up sound rather than the raw microphone, so a keyboard or a fan does not open it. Costs whatever the noise model costs."
                    checked={voice.advancedActivity}
                    onChange={(next) => setVoice({ advancedActivity: next })}
                />
                <Toggle
                    label="Send the microphone untouched"
                    note="Turns off the browser's echo, noise and level handling together, for an interface or a feed that has already done all three. Doing it twice is what ruins that sound."
                    checked={voice.bypassProcessing}
                    onChange={(next) => setVoice({ bypassProcessing: next })}
                />
                <Toggle
                    label="Say when nothing is picked up"
                    note="A microphone that opened but hears nothing looks exactly like somebody who is not talking. This is the only thing that would tell you."
                    checked={voice.noAudioWarning}
                    onChange={(next) => setVoice({ noAudioWarning: next })}
                />
                <Toggle
                    label="Ask before switching rooms mid-call"
                    note="Joining another voice room hangs up the call you are in. Off by default, because most of the time that is what pressing it meant."
                    checked={voice.switchWarning}
                    onChange={(next) => setVoice({ switchWarning: next })}
                />
                <Toggle
                    label="Quieten the call while you talk"
                    note="Turns the room down while your microphone is open. It is Polaris's own sound, not the machine's - a page cannot reach your other applications."
                    checked={voice.attenuate}
                    onChange={(next) => setVoice({ attenuate: next })}
                />
                {voice.attenuate ? (
                    <div className="flex flex-col gap-1">
                        <span className="flex items-center justify-between gap-2 text-sm">
                            How far
                            <span className="tabular-nums text-muted-foreground">{voice.attenuation}%</span>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            value={voice.attenuation}
                            aria-label="How far the call is quietened"
                            onChange={(event) => setVoice({ attenuation: Number(event.target.value) })}
                            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                        />
                        <span className="text-xs text-muted-foreground">
                            A hundred is silence while you are speaking.
                        </span>
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}

/** One switch and what it is for. Repeated six times, which is why it is one
 *  component: six near-copies is six chances for one of them to look different. */
function Toggle({
    label,
    note,
    checked,
    onChange
}: {
    label: string;
    note: string;
    checked: boolean;
    onChange: (next: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm">{label}</span>
                <span className="text-xs text-muted-foreground">{note}</span>
            </div>
            <Switch checked={checked} onChange={onChange} aria-label={label} />
        </div>
    );
}

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
 * only honest answer to "is it picking me up". The camera shows itself, with
 * whatever background is switched on already drawn behind it - a background is
 * the one call setting nobody can check from inside a call, because the only
 * person who cannot see it there is the person it is hiding. Neither test
 * touches a call. The level is live on arrival only where the browser has
 * already been allowed the microphone, and in a call it reads the call's own -
 * see `MicLevelMeter`; everything else waits for somebody to press it.
 *
 * Everything here is per browser. A headset is plugged into a machine, not into
 * an account, and the laptop in the kitchen and the desk with the headset want
 * different answers.
 */

import { refusalOf } from "@/app/(app)/chat/call-media";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { filterMic, type FilteredMic } from "@/app/(app)/chat/mic-filter";
import { Camera, ImagePlus, Loader2, Mic, Square } from "lucide-react";
import { useCameras } from "@/app/(app)/chat/camera-device";
import { afterPaint, maskCamera, type MaskedCamera } from "@/app/(app)/chat/camera-filter";
import { useMicrophones } from "@/app/(app)/chat/mic-device";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHeldCall } from "@/app/(app)/chat/call-hold";
import { MicLevelMeter } from "@/app/(app)/chat/mic-level-meter";
import { Button, Card, CardBody, Select, Switch, cn } from "@polaris/ui";
import { useMicGain, GAIN_MAX, GAIN_MIN } from "@/app/(app)/chat/mic-gain";
import { NOISE_LEVELS, micConstraints, useMicCleanup } from "@/app/(app)/chat/mic-cleanup";
import {
    BACKGROUNDS,
    BACKGROUND_SCENES,
    sceneOf,
    useCameraBackground
} from "@/app/(app)/chat/camera-background";
import {
    INPUT_MODES,
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
function keyName(code: string, t: NamespaceTranslator<"account">): string {
    if (code === "Space") return t("devices.keys.space");
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) return t("devices.keys.numpad", { key: code.slice(6) });
    if (code.startsWith("Arrow")) return t("devices.keys.arrow", { direction: code.slice(5) });
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
function MicrophoneCard({
    threshold,
    showThreshold
}: {
    threshold: number;
    showThreshold: boolean;
}) {
    const { devices, chosenId, choose } = useMicrophones();
    const t = useTranslations("account");
    const tChat = useTranslations("chat");
    const [cleanup, setCleanup] = useMicCleanup();
    const [gain, setGain] = useMicGain();
    const [testing, setTesting] = useState(false);
    /** What the noise model did when it was actually asked to start. Null until
     *  the test has run, and null again when it is stopped. */
    const [filterState, setFilterState] = useState<FilteredMic | null>(null);
    const filter = useRef<FilteredMic | null>(null);
    const [error, setError] = useState("");
    const stream = useRef<MediaStream | null>(null);
    /** The microphone the test opened, which the meter reads rather than opening
     *  another. */
    const [tested, setTested] = useState<MediaStreamTrack | null>(null);
    /** The call's own microphone, when there is a call: the meter reads it rather
     *  than asking the browser for the same device a second time. */
    const held = useHeldCall();
    const inCall = held?.session ? (held.call.localStream?.getAudioTracks()[0] ?? null) : null;

    const stop = useCallback(() => {
        // The graph goes before the device does: it holds an audio context, and
        // a context left open on a screen somebody wandered away from is the
        // same light left on as an open microphone.
        void filter.current?.stop();
        filter.current = null;
        for (const track of stream.current?.getTracks() ?? []) track.stop();
        stream.current = null;
        setTested(null);
        setTesting(false);
        setFilterState(null);
    }, []);

    // Never left running. A tab closed on an open microphone is a light that
    // stays on, and this is a screen somebody opens and wanders away from.
    useEffect(() => stop, [stop]);

    const start = async () => {
        setError("");
        setFilterState(null);
        try {
            // The same constraints a call opens with, so what is measured here
            // is what the room will hear. A test through a different chain is a
            // test of something else.
            const opened = await navigator.mediaDevices.getUserMedia({
                audio: micConstraints(chosenId ?? undefined)
            });
            stream.current = opened;
            const track = opened.getAudioTracks()[0] ?? null;
            setTested(track);
            setTesting(true);

            // Built for real, with the settings on this screen, because the only
            // honest answer to "is the noise model working" is to start it. It
            // used to fail silently: the setting still said enhanced, the call
            // was simply quieter, and there was nowhere at all to find out - so
            // this is the screen that finds out, and the reason comes with it.
            if (track) {
                const built = await filterMic(track, cleanup);
                setFilterState(built);
                filter.current = built;
            }
        } catch (caught) {
            setError(tChat(`media.refused.${refusalOf(caught)}` as const, { device: "microphone" }));
            stop();
        }
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="flex items-center gap-1.5 text-sm font-medium">
                        <Mic className="size-4 shrink-0 text-muted-foreground" />
                        {t("devices.mic.title")}
                    </h2>
                    <Button
                        size="sm"
                        variant={testing ? "secondary" : "outline"}
                        onClick={() => (testing ? stop() : void start())}
                    >
                        {testing ? (
                            <>
                                <Square className="size-3.5 shrink-0" />
                                {t("devices.stop")}
                            </>
                        ) : (
                            t("devices.mic.test")
                        )}
                    </Button>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                    {t("devices.whichOne")}
                    <Select
                        value={chosenId ?? ""}
                        onValueChange={(value) => choose(value)}
                        aria-label={t("devices.mic.title")}
                        options={
                            devices.length > 0
                                ? devices.map((device) => ({
                                      value: device.id,
                                      label: device.label
                                  }))
                                : [{ value: "", label: t("devices.mic.pressTest") }]
                        }
                    />
                    <span className="text-xs text-muted-foreground">{t("devices.mic.namesHint")}</span>
                </label>

                <div className="flex flex-col gap-1.5">
                    <span className="text-sm">{t("devices.mic.level")}</span>
                    {/* Drawn whether or not anything is being measured: an empty
                        row is what says the test is the thing that fills it. */}
                    <MicLevelMeter
                        track={tested ?? inCall}
                        listen
                        deviceId={chosenId}
                        threshold={showThreshold ? threshold : undefined}
                    />
                    <span className="text-xs text-muted-foreground">
                        {testing ? t("devices.mic.saySomething") : t("devices.mic.watchBars")}
                    </span>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                    {t("devices.mic.noise")}
                    <Select
                        value={cleanup}
                        onValueChange={(value) => setCleanup(value as typeof cleanup)}
                        aria-label={t("devices.mic.noise")}
                        options={NOISE_LEVELS.map((entry) => ({
                            value: entry.value,
                            label: tChat(`callSettings.noise.${entry.value}.label` as const)
                        }))}
                    />
                    <span className="text-xs text-muted-foreground">
                        {tChat(`callSettings.noise.${cleanup}.help` as const)}
                    </span>
                    {/* What the model DID, once it has been asked to. A setting
                        that says "enhanced" while the model has never started is
                        the state that took a call's sound away and left nothing
                        anywhere to read; this is where it is readable. */}
                    {filterState?.problem ? (
                        <span className="text-xs text-warning">
                            {t("devices.mic.unfiltered", { problem: filterState.problem })}
                        </span>
                    ) : filterState ? (
                        <span className="text-xs text-success">
                            {filterState.using === "gain"
                                ? t("devices.mic.runningNoModel")
                                : t("devices.mic.running", { model: filterState.using })}
                        </span>
                    ) : null}
                </label>

                <div className="flex flex-col gap-1">
                    <span className="flex items-center justify-between gap-2 text-sm">
                        {t("devices.mic.volume")}
                        <span className="tabular-nums text-muted-foreground">{percent(gain)}</span>
                    </span>
                    <input
                        type="range"
                        min={GAIN_MIN * 100}
                        max={GAIN_MAX * 100}
                        step={5}
                        value={Math.round(gain * 100)}
                        aria-label={t("devices.mic.volumeLabel")}
                        onChange={(event) => setGain(Number(event.target.value) / 100)}
                        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                    />
                    <span className="text-xs text-muted-foreground">{t("devices.mic.volumeHint")}</span>
                </div>

                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

/** Which camera, what it is pointing at, and what is drawn behind you. */
function CameraCard() {
    const { devices, chosenId, choose } = useCameras();
    const t = useTranslations("account");
    const tChat = useTranslations("chat");
    const {
        background,
        image,
        choose: chooseBackground,
        chooseScene,
        pickImage
    } = useCameraBackground();
    /** Whether the picture in use is one of theirs rather than one of ours. */
    const own = image !== null && sceneOf(image) === null;
    const [showing, setShowing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    /** What the background did when it was actually asked to start, in the same
     *  shape and for the same reason as the microphone's filter above: a setting
     *  that says "blur" while nothing is running is the state somebody has to be
     *  able to see. */
    const [maskState, setMaskState] = useState<MaskedCamera | null>(null);
    const [building, setBuilding] = useState(false);
    const [pickProblem, setPickProblem] = useState("");
    const video = useRef<HTMLVideoElement>(null);
    const stream = useRef<MediaStream | null>(null);
    const masked = useRef<MaskedCamera | null>(null);
    const picker = useRef<HTMLInputElement>(null);
    /**
     * The call's own camera, when there is a call sending one.
     *
     * Shown instead of opening a second one, for the reason the level meter
     * above reads the call's microphone: a camera another application already
     * holds is a camera some machines will not open twice, and the picture the
     * call is sending is a better answer to "what do I look like" than a second
     * capture of the same room would be. It already has the background drawn on
     * it, because that is what a call sends.
     */
    const held = useHeldCall();
    const inCall = held?.session ? (held.call.localStream?.getVideoTracks()[0] ?? null) : null;

    /** Point the preview at a track, whichever of the three it is. */
    const show = useCallback((track: MediaStreamTrack | null) => {
        if (!video.current || !track) return;
        video.current.srcObject = new MediaStream([track]);
        void video.current.play().catch(() => undefined);
    }, []);

    const stop = useCallback(() => {
        // The canvas goes before the device does, for the reason the microphone
        // graph does: it holds a worker and a model, and a screen somebody has
        // wandered away from should be running neither.
        void masked.current?.stop();
        masked.current = null;
        setMaskState(null);
        setBuilding(false);
        for (const track of stream.current?.getTracks() ?? []) track.stop();
        stream.current = null;
        if (video.current) video.current.srcObject = null;
        setShowing(false);
    }, []);

    useEffect(() => stop, [stop]);

    // The call's camera, as it changes: turned on or off mid-call, swapped for
    // another device, or handed a new background.
    useEffect(() => {
        if (!showing || !inCall) return;
        show(inCall);
    }, [inCall, show, showing]);

    /**
     * Draw the background that is switched on, and draw it again when it
     * changes.
     *
     * This preview is the only place a background can be checked at all - in a
     * call, the one person who cannot see it is the person it is hiding - so it
     * is built for real rather than approximated: the same function a call uses,
     * on the camera this screen opened.
     */
    useEffect(() => {
        // Nothing to build against a call's camera: the call built it, and
        // building a second one here would run two models on one device.
        if (!showing || inCall) return;
        const camera = stream.current?.getVideoTracks()[0] ?? null;
        if (!camera) return;

        let dropped = false;
        setBuilding(background !== "off");
        void (async () => {
            // So the line that says it is starting is on the glass before the
            // model takes the thread for a second - see `afterPaint`.
            await afterPaint();
            const built = await maskCamera(camera, background, image);
            // The setting moved again, or the preview was stopped, while the
            // model was loading.
            if (dropped) {
                await built?.stop();
                return;
            }
            const previous = masked.current;
            masked.current = built?.track ? built : null;
            setMaskState(built);
            setBuilding(false);
            show(masked.current?.track ?? camera);
            await previous?.stop();
        })();

        return () => {
            dropped = true;
        };
    }, [background, image, inCall, show, showing]);

    const start = async () => {
        setError("");
        // A call is already holding a camera and already drawing the background
        // on it. Nothing to open.
        if (inCall) {
            setShowing(true);
            show(inCall);
            return;
        }
        setBusy(true);
        try {
            const opened = await navigator.mediaDevices.getUserMedia({
                video: chosenId ? { deviceId: { exact: chosenId } } : true
            });
            stream.current = opened;
            setShowing(true);
            // The camera itself first, so there is a picture while the model
            // loads; the effect above swaps the composited one in when it is
            // ready.
            show(opened.getVideoTracks()[0] ?? null);
        } catch (caught) {
            setError(tChat(`media.refused.${refusalOf(caught)}` as const, { device: "camera" }));
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
                        {t("devices.camera.title")}
                    </h2>
                    <Button
                        size="sm"
                        variant={showing ? "secondary" : "outline"}
                        disabled={busy}
                        onClick={() => (showing ? stop() : void start())}
                    >
                        {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : null}
                        {showing ? t("devices.stop") : t("devices.camera.show")}
                    </Button>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                    {t("devices.whichOne")}
                    <Select
                        value={chosenId ?? ""}
                        onValueChange={(value) => choose(value || null)}
                        aria-label={t("devices.camera.title")}
                        options={
                            devices.length > 0
                                ? devices.map((device) => ({
                                      value: device.id,
                                      label: device.label
                                  }))
                                : [{ value: "", label: t("devices.camera.pressShow") }]
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
                    <p className="text-xs text-muted-foreground">{t("devices.camera.closed")}</p>
                ) : inCall ? (
                    <p className="text-xs text-muted-foreground">{t("devices.camera.inCall")}</p>
                ) : null}

                <label className="flex flex-col gap-1 text-sm">
                    {t("devices.camera.background")}
                    <Select
                        value={background}
                        onValueChange={(value) => {
                            const next = value as typeof background;
                            // With no picture chosen yet there is nothing for
                            // this to turn on, so it asks for one instead.
                            if (next === "image" && !image) {
                                setPickProblem("");
                                picker.current?.click();
                                return;
                            }
                            chooseBackground(next);
                        }}
                        aria-label={t("devices.camera.background")}
                        options={BACKGROUNDS.map((entry) => ({
                            value: entry.value,
                            label: tChat(`callSettings.backgrounds.${entry.value}.label` as const)
                        }))}
                    />
                    <span className="text-xs text-muted-foreground">
                        {tChat(`callSettings.backgrounds.${background}.help` as const)}
                    </span>
                </label>

                <div className="flex flex-col gap-2">
                    <span className="text-sm">{t("devices.camera.pictures")}</span>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                        {BACKGROUND_SCENES.map((scene) => (
                            <button
                                key={scene.id}
                                type="button"
                                title={tChat(scene.label)}
                                aria-label={tChat(scene.label)}
                                aria-pressed={image === scene.src}
                                onClick={() => chooseScene(scene)}
                                className={cn(
                                    "overflow-hidden rounded-md border-2 transition-colors",
                                    image === scene.src
                                        ? "border-primary"
                                        : "border-transparent hover:border-border-strong"
                                )}
                            >
                                <img
                                    src={scene.thumb}
                                    alt=""
                                    className="aspect-video w-full object-cover"
                                />
                            </button>
                        ))}
                        {/* Theirs, in the same row as the rest: a picture
                            somebody chose is one of the choices, not a setting
                            underneath them. */}
                        <button
                            type="button"
                            title={own ? t("devices.camera.changePicture") : t("devices.camera.ownPicture")}
                            aria-label={own ? t("devices.camera.changePicture") : t("devices.camera.ownPicture")}
                            aria-pressed={own}
                            onClick={() => picker.current?.click()}
                            className={cn(
                                "flex aspect-video items-center justify-center overflow-hidden rounded-md border-2 text-xs text-muted-foreground transition-colors",
                                own
                                    ? "border-primary"
                                    : "border-dashed border-border-strong hover:border-primary"
                            )}
                        >
                            {own && image ? (
                                <img src={image} alt="" className="size-full object-cover" />
                            ) : (
                                <ImagePlus className="size-4 shrink-0" />
                            )}
                        </button>
                    </div>
                    <span className="text-xs text-muted-foreground">{t("devices.camera.pictureStays")}</span>
                </div>
                <input
                    ref={picker}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        // Cleared either way, so choosing the same file twice is
                        // a second change event rather than silence.
                        event.target.value = "";
                        if (!file) return;
                        setPickProblem("");
                        void pickImage(file).catch((caught: unknown) =>
                            setPickProblem(
                                caught instanceof Error
                                    ? caught.message
                                    : t("devices.camera.pictureFailed")
                            )
                        );
                    }}
                />

                {/* What the model DID, once it has been asked to - the same
                    answer the microphone gives about its filter, and given for
                    the same reason. */}
                {pickProblem ? <p className="text-sm text-danger">{pickProblem}</p> : null}
                {showing && !inCall && building ? (
                    <p className="text-xs text-muted-foreground">{t("devices.camera.starting")}</p>
                ) : null}
                {showing && !inCall && maskState?.problem ? (
                    <p className="text-xs text-warning">
                        {t("devices.camera.failed", { problem: maskState.problem })}
                    </p>
                ) : showing && !inCall && maskState?.track ? (
                    <p className="text-xs text-success">{t("devices.camera.running")}</p>
                ) : null}

                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
/** How the microphone decides whether it is sending. */
function InputModeCard({ voice, setVoice }: { voice: VoiceSettings; setVoice: Change }) {
    const [listening, setListening] = useState(false);
    const t = useTranslations("account");
    const tChat = useTranslations("chat");

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
                <h2 className="text-sm font-medium">{t("devices.input.title")}</h2>

                <label className="flex flex-col gap-1 text-sm">
                    {t("devices.input.when")}
                    <Select
                        value={voice.inputMode}
                        onValueChange={(value) => setVoice({ inputMode: value as InputMode })}
                        aria-label={t("devices.input.modeLabel")}
                        options={INPUT_MODES.map((mode) => ({
                            value: mode,
                            label: tChat(`callSettings.inputModes.${mode}.label` as const)
                        }))}
                    />
                    <span className="text-xs text-muted-foreground">
                        {tChat(`callSettings.inputModes.${voice.inputMode}.note` as const)}
                    </span>
                </label>

                {voice.inputMode === "ptt" ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm">{t("devices.input.key")}</span>
                        <Button
                            size="sm"
                            variant={listening ? "secondary" : "outline"}
                            onClick={() => setListening(true)}
                        >
                            {listening ? t("devices.input.pressKey") : keyName(voice.pttKey, t)}
                        </Button>
                        <span className="text-xs text-muted-foreground">{t("devices.input.keyHint")}</span>
                    </div>
                ) : null}

                {voice.inputMode === "activity" ? (
                    <div className="flex flex-col gap-1">
                        <span className="flex items-center justify-between gap-2 text-sm">
                            {t("devices.input.threshold")}
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
                            aria-label={t("devices.input.thresholdLabel")}
                            onChange={(event) =>
                                setVoice({ activityThreshold: Number(event.target.value) })
                            }
                            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                        />
                        <span className="text-xs text-muted-foreground">{t("devices.input.thresholdHint")}</span>
                    </div>
                ) : null}

                {voice.inputMode !== "open" ? (
                    <div className="flex flex-col gap-1">
                        <span className="flex items-center justify-between gap-2 text-sm">
                            {t("devices.input.release")}
                            <span className="tabular-nums text-muted-foreground">
                                {voice.pttReleaseMs} ms
                            </span>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={1000}
                            step={50}
                            value={voice.pttReleaseMs}
                            aria-label={t("devices.input.releaseLabel")}
                            onChange={(event) =>
                                setVoice({ pttReleaseMs: Number(event.target.value) })
                            }
                            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                        />
                        <span className="text-xs text-muted-foreground">{t("devices.input.releaseHint")}</span>
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}

/** The things somebody only comes looking for when something is wrong. */
function AdvancedCard({ voice, setVoice }: { voice: VoiceSettings; setVoice: Change }) {
    const t = useTranslations("account");
    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">{t("devices.advanced.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("devices.advanced.intro")}</p>
                </div>

                <Toggle
                    label={t("devices.advanced.autoGain.label")}
                    note={t("devices.advanced.autoGain.note")}
                    checked={voice.autoGainControl}
                    onChange={(next) => setVoice({ autoGainControl: next })}
                />
                <Toggle
                    label={t("devices.advanced.betterDetection.label")}
                    note={t("devices.advanced.betterDetection.note")}
                    checked={voice.advancedActivity}
                    onChange={(next) => setVoice({ advancedActivity: next })}
                />
                <Toggle
                    label={t("devices.advanced.bypass.label")}
                    note={t("devices.advanced.bypass.note")}
                    checked={voice.bypassProcessing}
                    onChange={(next) => setVoice({ bypassProcessing: next })}
                />
                <Toggle
                    label={t("devices.advanced.noAudio.label")}
                    note={t("devices.advanced.noAudio.note")}
                    checked={voice.noAudioWarning}
                    onChange={(next) => setVoice({ noAudioWarning: next })}
                />
                <Toggle
                    label={t("devices.advanced.switchWarning.label")}
                    note={t("devices.advanced.switchWarning.note")}
                    checked={voice.switchWarning}
                    onChange={(next) => setVoice({ switchWarning: next })}
                />
                <Toggle
                    label={t("devices.advanced.attenuate.label")}
                    note={t("devices.advanced.attenuate.note")}
                    checked={voice.attenuate}
                    onChange={(next) => setVoice({ attenuate: next })}
                />
                {voice.attenuate ? (
                    <div className="flex flex-col gap-1">
                        <span className="flex items-center justify-between gap-2 text-sm">
                            {t("devices.advanced.howFar")}
                            <span className="tabular-nums text-muted-foreground">
                                {voice.attenuation}%
                            </span>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            value={voice.attenuation}
                            aria-label={t("devices.advanced.howFarLabel")}
                            onChange={(event) =>
                                setVoice({ attenuation: Number(event.target.value) })
                            }
                            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                        />
                        <span className="text-xs text-muted-foreground">{t("devices.advanced.howFarHint")}</span>
                    </div>
                ) : null}
                <div className="flex flex-col gap-1">
                    <span className="flex items-center justify-between gap-2 text-sm">
                        {t("devices.advanced.stream")}
                        <span className="tabular-nums text-muted-foreground">
                            {voice.streamAttenuation}%
                        </span>
                    </span>
                    <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={voice.streamAttenuation}
                        aria-label={t("devices.advanced.streamLabel")}
                        onChange={(event) =>
                            setVoice({ streamAttenuation: Number(event.target.value) })
                        }
                        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                    />
                    <span className="text-xs text-muted-foreground">{t("devices.advanced.streamHint")}</span>
                </div>
            </CardBody>
        </Card>
    );
}

/** A shipped background's name in the reader's language; one the catalog does
 *  not know yet keeps the name it was shipped with. */
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

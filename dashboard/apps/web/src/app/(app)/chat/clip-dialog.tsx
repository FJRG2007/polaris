"use client";

/**
 * Recording a screen clip, from the two questions to the finished file.
 *
 * The whole flow is one dialog on purpose. Choosing what to record, watching it
 * record, and deciding whether to keep it are one act, and a wizard that walked
 * between three screens would put a decision between somebody and the thing they
 * are demonstrating.
 *
 * What it hands back is a file. The composer stages it like any other
 * attachment, so a clip can be sent with a line of text, with other files, or
 * scheduled for the morning - none of which is a special case here.
 */

import { callDevices } from "./call-media";
import { useEffect, useRef, useState } from "react";
import { micDevice } from "./mic-device";
import { MicSettings } from "./mic-settings";
import { MediaPlayer } from "@/components/media-player";
import { MAX_CLIP_SECONDS, useClipRecorder, type ClipSources } from "./clip-recorder";
import { Camera, CameraOff, Circle, Mic, MicOff, Pause, Play, RotateCcw, Square } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    cn
} from "@polaris/ui";

/** Seconds as a clock reads them. */
function clock(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One of the two switches above the recording. Drawn as a pressed state rather
 *  than a checkbox: they are being chosen at a glance, next to a button. */
function SourceToggle({
    on,
    onToggle,
    label,
    children
}: {
    on: boolean;
    onToggle: () => void;
    label: string;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-pressed={on}
            aria-label={label}
            title={label}
            onClick={onToggle}
            className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                on
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
        >
            {children}
        </button>
    );
}

export function ClipDialog({
    open,
    onOpenChange,
    onReady,
    maxBytes,
    maxMib
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The finished clip, handed to the composer to be staged like any other
     *  file. The dialog closes itself once it has been taken. */
    onReady: (file: File) => void;
    maxBytes: number;
    maxMib: number;
}) {
    const clip = useClipRecorder({ maxBytes });
    const [sources, setSources] = useState<ClipSources>({ camera: false, microphone: true });
    /**
     * What this machine has to record with.
     *
     * Asked when the dialog opens and again whenever something is plugged in.
     * A browser only names devices once it has been given a permission, so
     * before that these read "Camera 1" and "Microphone 1" - which is still a
     * choice between two things, and is what every client shows at that point.
     */
    const [devices, setDevices] = useState<{
        microphones: { id: string; label: string }[];
        cameras: { id: string; label: string }[];
    }>({ microphones: [], cameras: [] });

    useEffect(() => {
        if (!open) return;
        let live = true;
        const look = () => {
            void callDevices().then((found) => {
                if (live) setDevices(found);
            });
        };
        look();
        // The microphone is the one already chosen for calls and voice messages:
        // picking the good headset in a call and then being recorded through the
        // laptop lid is a surprise that only turns up in the recording.
        setSources((current) => ({ ...current, microphoneId: micDevice() }));
        navigator.mediaDevices?.addEventListener?.("devicechange", look);
        return () => {
            live = false;
            navigator.mediaDevices?.removeEventListener?.("devicechange", look);
        };
    }, [open]);
    /** Where the composed picture is shown while it records. The canvas is made
     *  by the recorder and put into the page here - it is the same element, not a
     *  copy, so what is on screen is exactly what is being recorded. */
    const live = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const holder = live.current;
        if (!holder || !clip.canvas) return;
        clip.canvas.className = "size-full object-contain";
        holder.replaceChildren(clip.canvas);
        return () => holder.replaceChildren();
    }, [clip.canvas]);

    const running = clip.stage === "recording" || clip.stage === "paused";

    /** Closing while it runs stops it rather than leaving the screen shared. The
     *  recording is thrown away with it: a clip nobody kept is not a clip. */
    const close = () => {
        if (running) clip.stop();
        clip.discard();
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Record a clip</DialogTitle>
                    <DialogDescription>
                        Polaris records the screen or window you pick and puts the video in your
                        message. Up to {clock(MAX_CLIP_SECONDS)} and {maxMib} MB.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    {/* Before it starts: what goes in besides the screen. Both
                        are asked here rather than mid-recording, because turning
                        a camera on halfway through means asking for it halfway
                        through and the browser's own prompt over the recording. */}
                    {clip.stage === "idle" && (
                        <div className="flex flex-wrap items-center gap-2">
                            <SourceToggle
                                on={sources.camera}
                                label={sources.camera ? "Camera on" : "Camera off"}
                                onToggle={() =>
                                    setSources((current) => ({ ...current, camera: !current.camera }))
                                }
                            >
                                {sources.camera ? (
                                    <Camera className="size-3.5" />
                                ) : (
                                    <CameraOff className="size-3.5" />
                                )}
                                Camera
                            </SourceToggle>
                            <SourceToggle
                                on={sources.microphone}
                                label={sources.microphone ? "Microphone on" : "Microphone off"}
                                onToggle={() =>
                                    setSources((current) => ({
                                        ...current,
                                        microphone: !current.microphone
                                    }))
                                }
                            >
                                {sources.microphone ? (
                                    <Mic className="size-3.5" />
                                ) : (
                                    <MicOff className="size-3.5" />
                                )}
                                Microphone
                            </SourceToggle>
                            <p className="w-full text-xs text-muted-foreground">
                                Your browser asks which screen or window to record. The camera goes
                                in the corner of the picture.
                            </p>

                            {/* Which one, where there is more than one to choose
                                between. A machine with a single camera is not
                                asked a question it has no answer to. */}
                            {sources.camera && devices.cameras.length > 1 && (
                                <label className="flex w-full flex-col gap-1 text-xs">
                                    Camera
                                    <Select
                                        aria-label="Camera"
                                        value={sources.cameraId ?? devices.cameras[0]?.id ?? ""}
                                        onValueChange={(id) =>
                                            setSources((current) => ({ ...current, cameraId: id }))
                                        }
                                        options={devices.cameras.map((device) => ({
                                            value: device.id,
                                            label: device.label
                                        }))}
                                    />
                                </label>
                            )}
                            {/* Everything about the microphone, not only which
                                one: what it takes out of the room and how loud
                                it goes out matter more in a clip than in a call,
                                because a clip is watched rather than answered -
                                nobody can ask you to say that again. The same
                                settings as the composer's and the call's, since
                                it is one microphone. */}
                            {sources.microphone && (
                                <MicSettings className="w-full rounded-md border border-border p-2" />
                            )}
                        </div>
                    )}

                    {/* While it runs: the picture being recorded, when there is
                        one to draw. Without a camera the recording is the screen
                        itself, and drawing a copy of the screen inside the screen
                        is a hall of mirrors nobody can watch. */}
                    {running && (
                        <div className="flex flex-col gap-2">
                            {clip.canvas ? (
                                <div
                                    ref={live}
                                    className="aspect-video w-full overflow-hidden rounded-md border border-border bg-black"
                                />
                            ) : (
                                <div className="flex aspect-video w-full items-center justify-center rounded-md border border-border bg-muted/30 text-sm text-muted-foreground">
                                    Recording your screen
                                </div>
                            )}
                        </div>
                    )}

                    {/* Once it is stopped: what was made, before anybody sends it. */}
                    {clip.stage === "ready" && clip.preview && (
                        // The same player the conversation will draw around it,
                        // rather than the browser's own controls: what is being
                        // decided here is whether to send this, and it has to be
                        // watched the way it will be watched. It also seeks -
                        // see the duration repair in `MediaPlayer`, without which
                        // a browser recording has no end to seek towards.
                        <MediaPlayer
                            kind="video"
                            src={clip.preview}
                            download={clip.preview}
                            className="overflow-hidden rounded-md border border-border bg-black"
                        />
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                        {clip.stage === "idle" && (
                            <Button onClick={() => void clip.start(sources)}>
                                <Circle className="size-4 fill-current text-danger" />
                                Start recording
                            </Button>
                        )}
                        {clip.stage === "starting" && (
                            <p className="text-sm text-muted-foreground">Waiting for the screen...</p>
                        )}
                        {running && (
                            <>
                                <span className="flex items-center gap-2 text-sm tabular-nums">
                                    <Circle
                                        className={cn(
                                            "size-3 fill-current",
                                            clip.stage === "recording"
                                                ? "animate-pulse text-danger"
                                                : "text-muted-foreground"
                                        )}
                                    />
                                    {clock(clip.seconds)}
                                    <span className="text-muted-foreground">
                                        / {clock(MAX_CLIP_SECONDS)}
                                    </span>
                                </span>
                                {clip.stage === "recording" ? (
                                    <Button size="sm" variant="secondary" onClick={clip.pause}>
                                        <Pause className="size-4" />
                                        Pause
                                    </Button>
                                ) : (
                                    <Button size="sm" variant="secondary" onClick={clip.resume}>
                                        <Play className="size-4" />
                                        Resume
                                    </Button>
                                )}
                                <Button size="sm" onClick={clip.stop}>
                                    <Square className="size-4" />
                                    Stop
                                </Button>
                            </>
                        )}
                        {clip.stage === "ready" && clip.file && (
                            <>
                                <Button
                                    onClick={() => {
                                        onReady(clip.file as File);
                                        clip.discard();
                                        onOpenChange(false);
                                    }}
                                >
                                    Attach it
                                </Button>
                                <Button size="sm" variant="secondary" onClick={clip.discard}>
                                    <RotateCcw className="size-4" />
                                    Record again
                                </Button>
                                <span className="text-xs text-muted-foreground">
                                    {clock(clip.seconds)}, {Math.max(1, Math.round(clip.file.size / (1024 * 1024)))} MB
                                </span>
                            </>
                        )}
                    </div>

                    {clip.error && (
                        <p role="alert" className="text-xs text-danger">
                            {clip.error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={close}>
                        {running ? "Stop and close" : "Close"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

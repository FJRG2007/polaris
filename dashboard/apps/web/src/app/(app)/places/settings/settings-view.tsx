"use client";

/**
 * How the house is set up: where footage goes, and what does the recognizing.
 *
 * Two settings, and both are decisions somebody makes once. Storage is shared
 * with the rest of Polaris on purpose - a house that has a NAS should not have to
 * be told about it twice - and it is re-read on every write, so connecting one
 * later moves new footage onto it with no migration.
 *
 * Recognition is off until it is switched on, and switching it off stops its
 * container rather than only ignoring it - it is the one part of Places that
 * costs something while nothing is happening, because the models sit in memory
 * whether or not a camera ever asks it anything.
 *
 * It is installed from here, on a machine chosen here, because it is
 * part of Home rather than something to go and find. The address and key fields
 * are still underneath for a house that already runs its own - they speak the
 * same dialect - but nobody has to touch them to get a name on an event.
 */

import Link from "next/link";
import * as actions from "../actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { CircleAlert, CircleCheck, Loader2, ScanFace } from "lucide-react";
import { Button, Input, Select, Skeleton, Switch } from "@polaris/ui";

/** How often a recognizer that has not answered yet is asked again. Short: it is
 *  the difference between watching it come up and reloading the page to find
 *  out, and it only runs while somebody has this screen open and it is starting. */
const STARTING_EVERY_MS = 5000;

/** How many of those before it stops asking. Five minutes: comfortably past the
 *  minute or two a first start takes, and short of watching a machine that is
 *  never going to answer. */
const STARTING_TRIES = 60;

interface Settings {
    /** Whether the house wants faces put to names. Off unless it was turned on. */
    faceEnabled: boolean;
    /** Whether its container is up, which can disagree with the line above. */
    faceRunning: boolean;
    faceApiUrl: string;
    hasFaceKey: boolean;
    recognizerReady: boolean;
    /** Where Home put one of its own, in words. Null when it has not. */
    installedOn: string | null;
    /** Whether it is answering yet. A fresh one spends a minute starting. */
    answering: boolean;
}

interface Defaults {
    sensitivity: number;
    settleSeconds: number;
    minGapSeconds: number;
}

export function HomeSettingsView({
    storage,
    canAdmin
}: {
    /** Where footage lands today, resolved - a fact rather than a control. */
    storage: string;
    canAdmin: boolean;
}) {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [defaults, setDefaults] = useState<Defaults | null>(null);
    const [savingDefaults, setSavingDefaults] = useState(false);
    const [savedDefaults, setSavedDefaults] = useState(false);
    const [url, setUrl] = useState("");
    const [key, setKey] = useState("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [servers, setServers] = useState<{ id: string; label: string }[]>([]);
    const [server, setServer] = useState("local");
    const [installing, setInstalling] = useState(false);
    /** True once it has been given long enough to start and has not. */
    const [waited, setWaited] = useState(false);
    const [manual, setManual] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [result, tuning, machines] = await Promise.all([
                actions.homeSettingsAction(),
                actions.detectionDefaultsAction(),
                actions.listServersAction()
            ]);
            if (cancelled) return;
            if (result.error) setError(result.error);
            const value = result.settings ?? {
                faceEnabled: false,
                faceRunning: false,
                faceApiUrl: "",
                hasFaceKey: false,
                recognizerReady: false,
                installedOn: null,
                answering: false
            };
            setSettings(value);
            setUrl(value.faceApiUrl);
            // Only opened by hand. A house that already typed an address keeps
            // seeing it; everybody else is offered the button and nothing else.
            setManual(Boolean(value.faceApiUrl));
            setDefaults(tuning.defaults ?? null);
            setServers(machines.servers ?? []);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    /**
     * A recognizer that has just been installed is not answering yet.
     *
     * It pulls a few hundred megabytes and then loads its models, which is the
     * minute or two the card says it is - and nothing tells this screen when that
     * finishes. So the card sat on "Starting" until somebody reloaded the page
     * and found it had been running the whole time.
     *
     * Only while it is starting, and not forever. Once it answers there is
     * nothing left to watch, and every ask is a request to the machine it runs
     * on - so a screen left open on an install that never came up stops asking
     * and says so rather than spinning at it all afternoon.
     */
    useEffect(() => {
        // Nothing to watch for a house that has it switched off: the container is
        // being stopped, not started, and asking a machine every five seconds
        // whether something nobody wants is answering yet is the exact cost that
        // switching it off was about.
        if (!settings?.faceEnabled) return;
        if (!settings.installedOn || settings.answering || waited) return;
        let left = STARTING_TRIES;
        const timer = setInterval(() => {
            if (left <= 0) {
                clearInterval(timer);
                setWaited(true);
                return;
            }
            left -= 1;
            void actions
                .homeSettingsAction()
                .then((fresh) => {
                    if (fresh.settings) setSettings(fresh.settings);
                })
                .catch(() => {
                    // A refused answer is the machine still coming up, which is
                    // what this is waiting for. The next tick asks again.
                });
        }, STARTING_EVERY_MS);
        return () => clearInterval(timer);
    }, [settings?.faceEnabled, settings?.installedOn, settings?.answering, waited]);

    const [switching, setSwitching] = useState(false);

    /** Turn recognition on or off. Applied on screen first, and put back if the
     *  server disagrees - starting a container is slow enough that a switch which
     *  waits for it reads as one that did not take. */
    const setEnabled = async (next: boolean) => {
        setSwitching(true);
        setError(null);
        setSettings((current) => (current ? { ...current, faceEnabled: next, faceRunning: next } : current));
        const result = await runAction(() => actions.setFaceEnabledAction(next), setError);
        setSwitching(false);
        if (result?.error) {
            setSettings((current) =>
                current ? { ...current, faceEnabled: !next, faceRunning: !next } : current
            );
            return;
        }
        const fresh = await actions.homeSettingsAction();
        if (fresh.settings) setSettings(fresh.settings);
    };

    const install = async () => {
        setInstalling(true);
        setError(null);
        const result = await runAction(() => actions.installRecognizerAction(server), setError);
        if (result?.error) {
            setInstalling(false);
            setError(result.error);
            return;
        }
        const fresh = await actions.homeSettingsAction();
        setInstalling(false);
        if (fresh.settings) setSettings(fresh.settings);
    };

    const saveDefaults = async () => {
        if (!defaults) return;
        setSavingDefaults(true);
        setSavedDefaults(false);
        setError(null);
        const result = await runAction(() => actions.setDetectionDefaultsAction(defaults), setError);
        setSavingDefaults(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSavedDefaults(true);
    };

    const saveRecognizer = async () => {
        setSaving(true);
        setSaved(false);
        setError(null);
        const result = await runAction(() => actions.setFaceRecognitionAction(url, key), setError);
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setKey("");
        setSaved(true);
        setSettings((current) => {
            if (!current) return current;
            const paired = Boolean(url.trim()) && (Boolean(key.trim()) || current.hasFaceKey);
            return {
                ...current,
                faceApiUrl: url.trim(),
                hasFaceKey: paired,
                // One Home installed itself wins, so it stays ready either way.
                recognizerReady: paired || Boolean(current.installedOn)
            };
        });
    };

    return (
        <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
                <div>
                    <h2 className="text-[0.8125rem] font-semibold text-foreground">Where footage goes</h2>
                    <p className="mt-0.5 text-[0.75rem] leading-relaxed text-muted-foreground">
                        Recordings and the pictures that go with events are written to{" "}
                        <span className="text-foreground">{storage}</span>. That is set for the whole instance under
                        Uploads, beside where photos and attachments go - one place for one decision. A camera that
                        wants its own disk says so on its own settings.
                    </p>
                </div>
                {canAdmin ? (
                    <Button asChild variant="secondary" size="sm" className="self-start">
                        <Link href="/admin/uploads">Change it under Uploads</Link>
                    </Button>
                ) : null}
            </section>

            <section className="flex flex-col gap-3">
                <div>
                    <h2 className="text-[0.8125rem] font-semibold text-foreground">How sensitive a new camera is</h2>
                    <p className="mt-0.5 text-[0.75rem] leading-relaxed text-muted-foreground">
                        Nobody guesses these right the first time, and they are not the same for a hallway and a garden
                        facing a hedge. Set them once here, from the camera you have already tuned, and every camera
                        added afterwards starts there. Each camera can still disagree.
                    </p>
                </div>

                {defaults === null ? (
                    <Skeleton className="h-9 w-72" />
                ) : (
                    <>
                        <label className="flex flex-col gap-1.5">
                            <span className="text-[0.75rem] font-medium text-muted-foreground">
                                Sensitivity - {defaults.sensitivity}
                            </span>
                            <input
                                type="range"
                                min={1}
                                max={100}
                                value={defaults.sensitivity}
                                onChange={(event) => {
                                    setDefaults({ ...defaults, sensitivity: Number(event.target.value) });
                                    setSavedDefaults(false);
                                }}
                                className="w-64 accent-primary"
                                aria-label="Sensitivity"
                            />
                            <span className="text-[0.6875rem] text-foreground-subtle">
                                Higher notices smaller changes. Too high and every shadow is an event.
                            </span>
                        </label>

                        <label className="flex flex-col gap-1.5">
                            <span className="text-[0.75rem] font-medium text-muted-foreground">
                                Ignore anything shorter than
                            </span>
                            <Input
                                value={String(defaults.settleSeconds)}
                                onChange={(event) => {
                                    setDefaults({ ...defaults, settleSeconds: Number(event.target.value) || 0 });
                                    setSavedDefaults(false);
                                }}
                                className="w-24"
                                inputMode="numeric"
                                aria-label="Settle seconds"
                            />
                            <span className="text-[0.6875rem] text-foreground-subtle">
                                Seconds. This is the one that stops moths, gusts and passing lorries: nearly every
                                false alarm is over within a second or two, and a person is not.
                            </span>
                        </label>

                        <label className="flex flex-col gap-1.5">
                            <span className="text-[0.75rem] font-medium text-muted-foreground">
                                Wait between detections
                            </span>
                            <Input
                                value={String(defaults.minGapSeconds)}
                                onChange={(event) => {
                                    setDefaults({ ...defaults, minGapSeconds: Number(event.target.value) || 1 });
                                    setSavedDefaults(false);
                                }}
                                className="w-24"
                                inputMode="numeric"
                                aria-label="Wait between detections"
                            />
                            <span className="text-[0.6875rem] text-foreground-subtle">
                                Seconds. Somebody standing at a door is one thing that happened, not sixty.
                            </span>
                        </label>

                        <div className="flex items-center gap-2">
                            <Button variant="secondary" onClick={saveDefaults} disabled={savingDefaults}>
                                {savingDefaults ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                                Save
                            </Button>
                            {savedDefaults ? (
                                <span className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
                                    <CircleCheck className="size-3.5 shrink-0 text-success" />
                                    Saved
                                </span>
                            ) : null}
                        </div>
                    </>
                )}
            </section>

            <section className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="text-[0.8125rem] font-semibold text-foreground">Face recognition</h2>
                        <p className="mt-0.5 text-[0.75rem] leading-relaxed text-muted-foreground">
                            Off unless you turn it on. It puts names to the people you have taught it under People,
                            and only after a camera has already seen somebody - the pictures and what is learned from
                            them stay on the machine it runs on. While it is on it holds its models in memory, so
                            leave it off if you only want cameras to say that somebody is there.
                        </p>
                    </div>
                    {settings === null ? (
                        <Skeleton className="h-5 w-9 shrink-0" />
                    ) : (
                        <Switch
                            checked={settings.faceEnabled}
                            onChange={(next) => void setEnabled(next)}
                            disabled={switching}
                            aria-label="Face recognition"
                        />
                    )}
                </div>

                {settings === null ? (
                    <Skeleton className="h-9 w-72" />
                ) : !settings.faceEnabled ? (
                    settings.faceRunning ? (
                        // The two disagree, which is the state a house that
                        // installed a recognizer before there was a switch wakes
                        // up in. Said out loud, because "off" over a container
                        // that is still holding a gigabyte is the opposite of
                        // what somebody switching it off asked for.
                        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2">
                            <p className="flex items-center gap-1.5 text-[0.75rem] text-foreground">
                                <CircleAlert className="size-3.5 shrink-0 text-warning" />
                                Off, but still running on {settings.installedOn ?? "this server"}.
                            </p>
                            <p className="text-[0.6875rem] text-foreground-subtle">
                                Nothing is asking it anything. Stopping it gives back the memory it holds its models
                                in; turning recognition back on starts it again.
                            </p>
                            <Button
                                variant="secondary"
                                size="sm"
                                className="self-start"
                                disabled={switching}
                                onClick={() => void setEnabled(false)}
                            >
                                {switching ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                                Stop it
                            </Button>
                        </div>
                    ) : (
                        <p className="text-[0.75rem] text-foreground-subtle">
                            Cameras report that somebody is there, and never who. Nothing is running for it.
                        </p>
                    )
                ) : (
                    <>
                        {settings.installedOn ? (
                            <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2">
                                <p className="flex items-center gap-1.5 text-[0.75rem] text-foreground">
                                    {settings.answering ? (
                                        <CircleCheck className="size-3.5 shrink-0 text-success" />
                                    ) : waited ? (
                                        <CircleAlert className="size-3.5 shrink-0 text-warning" />
                                    ) : (
                                        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                                    )}
                                    {settings.answering
                                        ? `Running on ${settings.installedOn}.`
                                        : waited
                                          ? `Not answering on ${settings.installedOn}.`
                                          : `Starting on ${settings.installedOn}.`}
                                </p>
                                <p className="text-[0.6875rem] text-foreground-subtle">
                                    {settings.answering
                                        ? "Teach it who lives here under People, and cameras set to recognize faces will start using their names."
                                        : waited
                                          ? "It has had several minutes and has not come up. The machine may be busy pulling it down, or the container may have stopped - it is under Apps, by the name it was installed with."
                                          : "It loads its models the first time it starts, which takes a minute or two. Nothing is lost in the meantime - cameras still report that somebody is there."}
                                </p>
                                {waited ? (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="self-start"
                                        onClick={() => setWaited(false)}
                                    >
                                        Check again
                                    </Button>
                                ) : null}
                            </div>
                        ) : (
                            <div className="flex flex-wrap items-end gap-2">
                                <label className="flex flex-col gap-1.5">
                                    <span className="text-[0.75rem] font-medium text-muted-foreground">
                                        Run it on
                                    </span>
                                    <Select
                                        value={server}
                                        onValueChange={setServer}
                                        options={servers.map((machine) => ({
                                            value: machine.id,
                                            label: machine.label
                                        }))}
                                    />
                                </label>
                                <Button onClick={install} disabled={installing}>
                                    {installing ? (
                                        <Loader2 className="size-4 shrink-0 animate-spin" />
                                    ) : (
                                        <ScanFace className="size-4 shrink-0" />
                                    )}
                                    {installing ? "Installing" : "Install it"}
                                </Button>
                                <span className="pb-2 text-[0.6875rem] text-foreground-subtle">
                                    A few hundred megabytes, once. It runs on the processor - no graphics card needed.
                                </span>
                            </div>
                        )}

                        {/* Hidden once Home runs one of its own, because its own
                            wins: an address typed underneath a running install
                            would look saved and do nothing. */}
                        {settings.installedOn ? null : manual ? (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <label className="flex flex-col gap-1.5">
                                <span className="text-[0.75rem] font-medium text-muted-foreground">Address</span>
                                <Input
                                    value={url}
                                    onChange={(event) => setUrl(event.target.value)}
                                    className="w-72"
                                    placeholder="http://192.168.1.20:8000"
                                    aria-label="Recognizer address"
                                />
                            </label>
                            <label className="flex flex-col gap-1.5">
                                <span className="text-[0.75rem] font-medium text-muted-foreground">Key</span>
                                {/* enigma:allow-no-breach-check - this is a key the
                                    recognizer minted in its own interface, not a
                                    password anybody is choosing here.
                                    enigma:allow-identity-password - it belongs to a
                                    service, so there is no account identity for it
                                    to resemble. */}
                                <Input
                                    value={key}
                                    onChange={(event) => setKey(event.target.value)}
                                    className="w-72"
                                    type="password"
                                    autoComplete="off"
                                    aria-label="Recognition key"
                                    placeholder={settings.hasFaceKey ? "Stored. Type to replace it." : "Paste the key"}
                                />
                            </label>
                            <Button variant="secondary" onClick={saveRecognizer} disabled={saving}>
                                {saving ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                                Save
                            </Button>
                            {saved ? (
                                <span className="flex items-center gap-1.5 pb-2 text-[0.75rem] text-muted-foreground">
                                    <CircleCheck className="size-3.5 shrink-0 text-success" />
                                    Saved
                                </span>
                            ) : null}
                        </div>
                        ) : (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="self-start"
                                onClick={() => setManual(true)}
                            >
                                I already run my own
                            </Button>
                        )}

                        {!settings.recognizerReady ? (
                            <p className="text-[0.6875rem] text-foreground-subtle">
                                Until there is one, cameras set to recognize faces still report that somebody is there -
                                just not who.
                            </p>
                        ) : null}
                    </>
                )}
            </section>

            {error ? <p className="text-[0.75rem] text-danger">{error}</p> : null}
        </div>
    );
}

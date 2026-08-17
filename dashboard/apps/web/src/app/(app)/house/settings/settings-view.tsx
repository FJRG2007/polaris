"use client";

/**
 * How the house is set up: where footage goes, and what does the recognizing.
 *
 * Two settings, and both are decisions somebody makes once. Storage is shared
 * with the rest of Polaris on purpose - a house that has a NAS should not have to
 * be told about it twice - and it is re-read on every write, so connecting one
 * later moves new footage onto it with no migration.
 *
 * The recognizer is connected rather than installed, and the screen says so
 * plainly along with the command that starts one. Polaris installs single
 * containers; a recognizer is a stack with its own database, so pretending to
 * install it would be a button that fails for reasons nobody could act on.
 */

import * as actions from "../actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { CircleCheck, Loader2 } from "lucide-react";
import { Button, Input, Select, Skeleton } from "@polaris/ui";

interface Settings {
    faceApiUrl: string;
    hasFaceKey: boolean;
    recognizerReady: boolean;
}

export function HomeSettingsView({
    storage,
    targets
}: {
    /** What footage is written to today. */
    storage: string;
    targets: { id: string; label: string }[];
}) {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [target, setTarget] = useState(storage);
    const [url, setUrl] = useState("");
    const [key, setKey] = useState("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await actions.homeSettingsAction();
            if (cancelled) return;
            if (result.error) setError(result.error);
            const value = result.settings ?? { faceApiUrl: "", hasFaceKey: false, recognizerReady: false };
            setSettings(value);
            setUrl(value.faceApiUrl);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const saveTarget = async (next: string) => {
        const previous = target;
        setTarget(next);
        const result = await runAction(() => actions.setHomeStorageAction(next), setError);
        if (result?.error) {
            setError(result.error);
            setTarget(previous);
        }
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
        setSettings((current) =>
            current
                ? {
                      faceApiUrl: url.trim(),
                      hasFaceKey: Boolean(url.trim()) && (Boolean(key.trim()) || current.hasFaceKey),
                      recognizerReady: Boolean(url.trim()) && (Boolean(key.trim()) || current.hasFaceKey)
                  }
                : current
        );
    };

    return (
        <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
                <div>
                    <h2 className="text-[13px] font-semibold text-foreground">Where footage goes</h2>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                        Clips and the pictures that go with events. A NAS is the right answer if you have one - it is
                        the disk with the room and the backups. Changing this moves new footage only; what is already
                        stored stays readable where it is.
                    </p>
                </div>
                <Select
                    value={target}
                    onValueChange={saveTarget}
                    className="w-72"
                    aria-label="Where footage goes"
                    options={targets.map((option) => ({ value: option.id, label: option.label }))}
                />
            </section>

            <section className="flex flex-col gap-3">
                <div>
                    <h2 className="text-[13px] font-semibold text-foreground">Face recognition</h2>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                        Optional, and only needed for cameras set to work out who somebody is. Run a recognizer on any
                        machine you like and give Home its address and key. Faces are sent to it only after a camera has
                        already seen a person, and they never leave the machine it runs on.
                    </p>
                </div>

                {settings === null ? (
                    <Skeleton className="h-9 w-72" />
                ) : (
                    <>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <label className="flex flex-col gap-1.5">
                                <span className="text-[12px] font-medium text-muted-foreground">Address</span>
                                <Input
                                    value={url}
                                    onChange={(event) => setUrl(event.target.value)}
                                    className="w-72"
                                    placeholder="http://192.168.1.20:8000"
                                    aria-label="Recognizer address"
                                />
                            </label>
                            <label className="flex flex-col gap-1.5">
                                <span className="text-[12px] font-medium text-muted-foreground">Key</span>
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
                                <span className="flex items-center gap-1.5 pb-2 text-[12px] text-muted-foreground">
                                    <CircleCheck className="size-3.5 shrink-0 text-success" />
                                    Saved
                                </span>
                            ) : null}
                        </div>

                        {settings.recognizerReady ? (
                            <p className="text-[12px] text-muted-foreground">
                                Connected. Teach it who lives here under People.
                            </p>
                        ) : (
                            <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2">
                                <p className="text-[12px] text-muted-foreground">
                                    Nothing connected yet. CompreFace is the one Home is written against - it runs on
                                    its own with Docker, then mints a key under Face Recognition Services:
                                </p>
                                <code className="overflow-x-auto text-[11px] text-foreground-subtle">
                                    git clone https://github.com/exadel-inc/CompreFace &amp;&amp; cd CompreFace &amp;&amp;
                                    docker compose up -d
                                </code>
                                <p className="text-[11px] text-foreground-subtle">
                                    Until then, cameras set to recognize faces still report that somebody is there -
                                    just not who.
                                </p>
                            </div>
                        )}
                    </>
                )}
            </section>

            {error ? <p className="text-[12px] text-danger">{error}</p> : null}
        </div>
    );
}

"use client";

/**
 * Where calls run.
 *
 * A call between two browsers on the same wifi needs nothing, and that is what
 * Polaris does when this is empty. A call between two houses needs something in
 * the middle with a public address, and without one the two people sit there
 * looking at each other's names hearing nothing - which is the single thing
 * about calls that people report. So this is a button rather than a page of
 * documentation: one container, on a machine chosen here.
 *
 * The address and key fields underneath are for an instance that already runs
 * one. They speak the same dialect, and nobody has to touch them to make calls
 * work.
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Button, Input, Select, Skeleton } from "@polaris/ui";
import { CircleAlert, CircleCheck, Loader2, PhoneCall } from "lucide-react";

/** How often a server that has not answered yet is asked again. Short: it is the
 *  difference between watching it come up and reloading the page to find out. */
const STARTING_EVERY_MS = 5000;

/** How many of those before it stops asking. Five minutes: comfortably past a
 *  first start, and short of watching a machine that will never answer. */
const STARTING_TRIES = 60;

interface Settings {
    url: string;
    hasKey: boolean;
    installedOn: string | null;
    ready: boolean;
    answering: boolean;
}

const NOTHING: Settings = {
    url: "",
    hasKey: false,
    installedOn: null,
    ready: false,
    answering: false
};

export function CallServerView() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [url, setUrl] = useState("");
    const [key, setKey] = useState("");
    const [secret, setSecret] = useState("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [machines, setMachines] = useState<{ id: string; label: string }[]>([]);
    const [machine, setMachine] = useState("local");
    const [installing, setInstalling] = useState(false);
    /** True once it has been given long enough to start and has not. */
    const [waited, setWaited] = useState(false);
    const [manual, setManual] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [result, hosts] = await Promise.all([
                actions.callServerSettingsAction(),
                actions.callServerMachinesAction()
            ]);
            if (cancelled) return;
            if (result.error) setError(result.error);
            const value = result.settings ?? NOTHING;
            setSettings(value);
            setUrl(value.url);
            // Only opened by hand. An instance that already typed an address keeps
            // seeing it; everybody else is offered the button and nothing else.
            setManual(Boolean(value.url));
            setMachines(hosts.machines ?? []);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    /**
     * A server that has just been installed is not answering yet.
     *
     * It pulls the image and starts, and nothing tells this screen when that
     * finishes - so the card sat on "Starting" until somebody reloaded and found
     * it had been running the whole time. Only while it is starting, and not
     * forever: every ask is a request to the machine it runs on.
     */
    useEffect(() => {
        if (!settings?.installedOn || settings.answering || waited) return;
        let left = STARTING_TRIES;
        const timer = setInterval(() => {
            if (left <= 0) {
                clearInterval(timer);
                setWaited(true);
                return;
            }
            left -= 1;
            void actions
                .callServerSettingsAction()
                .then((fresh) => {
                    if (fresh.settings) setSettings(fresh.settings);
                })
                .catch(() => {
                    // A refused answer is the machine still coming up, which is
                    // what this is waiting for. The next tick asks again.
                });
        }, STARTING_EVERY_MS);
        return () => clearInterval(timer);
    }, [settings?.installedOn, settings?.answering, waited]);

    const install = async () => {
        setInstalling(true);
        setError(null);
        const result = await runAction(() => actions.installCallServerAction(machine), setError);
        if (result?.error) {
            setInstalling(false);
            setError(result.error);
            return;
        }
        const fresh = await actions.callServerSettingsAction();
        setInstalling(false);
        if (fresh.settings) setSettings(fresh.settings);
    };

    const save = async () => {
        setSaving(true);
        setSaved(false);
        setError(null);
        const result = await runAction(
            () => actions.setCallServerAction(url, key, secret),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSecret("");
        setSaved(true);
        const fresh = await actions.callServerSettingsAction();
        if (fresh.settings) setSettings(fresh.settings);
    };

    return (
        <section className="flex flex-col gap-3">
            <div>
                <h2 className="text-[13px] font-semibold text-foreground">Where calls run</h2>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                    Without one, a call is carried directly between browsers - which works between
                    two people on the same network and usually not between two houses. With one,
                    every browser sends its camera once instead of once per person, and calls
                    connect from anywhere.
                </p>
            </div>

            {settings === null ? (
                <Skeleton className="h-9 w-72" />
            ) : (
                <>
                    {settings.installedOn ? (
                        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2">
                            <p className="flex items-center gap-1.5 text-[12px] text-foreground">
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
                            <p className="text-[11px] text-foreground-subtle">
                                {settings.answering
                                    ? "New calls go through it. One already running carries on the way it started."
                                    : waited
                                      ? "It has had several minutes and has not come up. The machine may still be pulling it down, or the container may have stopped - it is under Apps, by the name it was installed with."
                                      : "It starts in a few seconds. Calls work in the meantime, between browsers that can reach each other."}
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
                                <span className="text-[12px] font-medium text-muted-foreground">
                                    Run it on
                                </span>
                                <Select
                                    value={machine}
                                    onValueChange={setMachine}
                                    options={machines.map((host) => ({
                                        value: host.id,
                                        label: host.label
                                    }))}
                                />
                            </label>
                            <Button onClick={install} disabled={installing}>
                                {installing ? (
                                    <Loader2 className="size-4 shrink-0 animate-spin" />
                                ) : (
                                    <PhoneCall className="size-4 shrink-0" />
                                )}
                                {installing ? "Installing" : "Install it"}
                            </Button>
                            <span className="pb-2 text-[11px] text-foreground-subtle">
                                Small, and it holds nothing: media passes through it and is never
                                written down.
                            </span>
                        </div>
                    )}

                    {/* Hidden once Polaris runs one of its own, because its own
                        wins: an address typed underneath a running install would
                        look saved and do nothing. */}
                    {settings.installedOn ? null : manual ? (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <label className="flex flex-col gap-1.5">
                                <span className="text-[12px] font-medium text-muted-foreground">
                                    Address
                                </span>
                                <Input
                                    value={url}
                                    onChange={(event) => setUrl(event.target.value)}
                                    className="w-64"
                                    placeholder="wss://calls.example.com"
                                    aria-label="Call server address"
                                />
                            </label>
                            <label className="flex flex-col gap-1.5">
                                <span className="text-[12px] font-medium text-muted-foreground">
                                    Key
                                </span>
                                <Input
                                    value={key}
                                    onChange={(event) => setKey(event.target.value)}
                                    className="w-40"
                                    autoComplete="off"
                                    aria-label="Call server key"
                                    placeholder="Its key name"
                                />
                            </label>
                            <label className="flex flex-col gap-1.5">
                                <span className="text-[12px] font-medium text-muted-foreground">
                                    Secret
                                </span>
                                {/* enigma:allow-no-breach-check - this is a secret
                                    the call server was configured with, not a
                                    password anybody is choosing here.
                                    enigma:allow-identity-password - it belongs to a
                                    service, so there is no account identity for it
                                    to resemble. */}
                                <Input
                                    value={secret}
                                    onChange={(event) => setSecret(event.target.value)}
                                    className="w-64"
                                    type="password"
                                    autoComplete="off"
                                    aria-label="Call server secret"
                                    placeholder={
                                        settings.hasKey ? "Stored. Type to replace it." : "Paste it"
                                    }
                                />
                            </label>
                            <Button variant="secondary" onClick={save} disabled={saving}>
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

                    {!settings.ready ? (
                        <p className="text-[11px] text-foreground-subtle">
                            Until there is one, calls only connect between browsers that can reach
                            each other directly.
                        </p>
                    ) : null}
                </>
            )}

            {error ? <p className="text-[12px] text-danger">{error}</p> : null}
        </section>
    );
}

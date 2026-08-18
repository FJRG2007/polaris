"use client";

/**
 * Where calls run.
 *
 * Polaris starts a media server with the stack, so on a working install this
 * card has nothing to ask for and one thing to say: whether it is up. It is
 * still worth a card, because "the call button is greyed out" is answered here
 * and nowhere else - and because an instance that already runs its own server
 * needs somewhere to say so.
 *
 * The ports are not this card's business. They decide whether a call reaches
 * somebody outside the house, which is a router question, and Domains is where
 * every other router question is already answered.
 */

import Link from "next/link";
import * as actions from "./actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Button, Input, Skeleton } from "@polaris/ui";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";

/** How often a server that has not answered yet is asked again. Short: it is the
 *  difference between watching it come up and reloading the page to find out. */
const STARTING_EVERY_MS = 5000;

/** How many of those before it stops asking. Two minutes is well past a start. */
const STARTING_TRIES = 24;

interface Settings {
    url: string;
    hasKey: boolean;
    shipped: boolean;
    ready: boolean;
    answering: boolean;
}

const NOTHING: Settings = { url: "", hasKey: false, shipped: false, ready: false, answering: false };

export function CallServerView() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [url, setUrl] = useState("");
    const [key, setKey] = useState("");
    const [secret, setSecret] = useState("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    /** True once it has been given long enough to start and has not. */
    const [waited, setWaited] = useState(false);
    const [manual, setManual] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await actions.callServerSettingsAction();
            if (cancelled) return;
            if (result.error) setError(result.error);
            const value = result.settings ?? NOTHING;
            setSettings(value);
            setUrl(value.url);
            // Only opened by hand. An instance that already typed an address keeps
            // seeing it; everybody else is shown the shipped server and nothing else.
            setManual(Boolean(value.url));
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    /**
     * A server that is still starting is not answering yet.
     *
     * It comes up with the stack, and nothing tells this screen when that
     * finishes - so the card sat on "Starting" until somebody reloaded and found
     * it had been running the whole time. Only while it is starting, and not
     * forever.
     */
    useEffect(() => {
        if (!settings?.ready || settings.answering || waited) return;
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
                    // A refused answer is the server still coming up, which is
                    // what this is waiting for. The next tick asks again.
                });
        }, STARTING_EVERY_MS);
        return () => clearInterval(timer);
    }, [settings?.ready, settings?.answering, waited]);

    const save = async () => {
        setSaving(true);
        setSaved(false);
        setError(null);
        const result = await runAction(() => actions.setCallServerAction(url, key, secret), setError);
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSecret("");
        setSaved(true);
        setWaited(false);
        const fresh = await actions.callServerSettingsAction();
        if (fresh.settings) setSettings(fresh.settings);
    };

    const where = settings?.shipped ? "on this server" : "at the address below";

    return (
        <section className="flex flex-col gap-3">
            <div>
                <h2 className="text-[13px] font-semibold text-foreground">Where calls run</h2>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                    Every call goes through a media server, so each browser sends its camera once
                    instead of once per person. Polaris starts one with the stack; until it answers,
                    Chat says calls are unavailable rather than offering one that reaches nobody.
                </p>
            </div>

            {settings === null ? (
                <Skeleton className="h-9 w-72" />
            ) : (
                <>
                    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2">
                        <p className="flex items-center gap-1.5 text-[12px] text-foreground">
                            {settings.answering ? (
                                <CircleCheck className="size-3.5 shrink-0 text-success" />
                            ) : waited || !settings.ready ? (
                                <CircleAlert className="size-3.5 shrink-0 text-warning" />
                            ) : (
                                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                            )}
                            {!settings.ready
                                ? "No call server is configured."
                                : settings.answering
                                  ? `Running ${where}.`
                                  : waited
                                    ? `Not answering ${where}.`
                                    : `Starting ${where}.`}
                        </p>
                        <p className="text-[11px] text-foreground-subtle">
                            {!settings.ready
                                ? "Calls are off until there is one. Re-run the installer, or point this at a server you already run."
                                : settings.answering ? (
                                      <>
                                          Calls between devices on this network work now. For calls
                                          from outside, two ports have to reach this machine -{" "}
                                          <Link href="/admin/domains" className="text-primary hover:underline">
                                              Domains
                                          </Link>{" "}
                                          lists them and reports when they answer.
                                      </>
                                  ) : waited ? (
                                      "It has had a couple of minutes and has not come up. Check the `livekit` container on this machine."
                                  ) : (
                                      "It comes up a few seconds after the stack does."
                                  )}
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

                    {manual ? (
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
                                    placeholder={settings.hasKey ? "Stored. Type to replace it." : "Paste it"}
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
                </>
            )}

            {error ? <p className="text-[12px] text-danger">{error}</p> : null}
        </section>
    );
}

"use client";

/**
 * Reading a Send.
 *
 * Three things have to happen in this order and none of them can happen on the
 * server: the key is read out of the URL fragment, the server is asked for the
 * payload (which it holds but cannot open), and the payload is decrypted here.
 *
 * A password, when there is one, is not sent either. It is stretched against the
 * link's own key first, so what crosses the wire is useless for anything else.
 */

import Link from "next/link";
import * as crypto from "@/lib/vault/crypto";
import { signInHref } from "@/lib/safe-redirect";
import { PublicShell } from "@/components/public-shell";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, Lock, LogIn } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";

/** The 16 bytes in the fragment, or null. */
function keyFromFragment(): Uint8Array | null {
    if (typeof window === "undefined") return null;
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return null;
    try {
        const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
        const bytes = crypto.fromBase64(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
        return bytes.length === 16 ? bytes : null;
    } catch {
        return null;
    }
}

/**
 * Where the key waits while its reader signs in. The sign-in round trip keeps
 * the path but drops the fragment, and the fragment must never ride in the
 * redirect query, where the server would see it - so it stays in this tab.
 */
const keySlot = (accessId: string) => `polaris-send-key:${accessId}`;

/** Put back a key parked before a sign-in, once, into the fragment it came from. */
function restoreParkedKey(accessId: string): void {
    try {
        const parked = window.sessionStorage.getItem(keySlot(accessId));
        if (!parked) return;
        window.sessionStorage.removeItem(keySlot(accessId));
        if (!window.location.hash) {
            window.history.replaceState(null, "", `${window.location.pathname}${parked}`);
        }
    } catch {
        // No storage here: the reader opens the link again from where they got it.
    }
}

function parkKey(accessId: string): void {
    try {
        window.sessionStorage.setItem(keySlot(accessId), window.location.hash);
    } catch {
        // As above.
    }
}

/** The owner's rules that refused this reader, as the server names them. */
const REFUSALS = {
    address: "blocked",
    scheduled: "scheduled",
    outside_hours: "closed",
    sign_in_required: "signIn",
    not_invited: "notInvited"
} as const;

type Refusal = (typeof REFUSALS)[keyof typeof REFUSALS];

/** What each failure says; the owner's rules are worded as on every other link. */
const FAILURE_WORDS = {
    incomplete: "send.incomplete",
    unavailable: "send.unavailable",
    mismatch: "send.mismatch",
    blocked: "send.blocked",
    scheduled: "denied.scheduled",
    closed: "denied.closed",
    signIn: "denied.signIn",
    notInvited: "denied.notInvited"
} as const;

type State =
    | { kind: "loading" }
    | { kind: "password" }
    | { kind: "open"; name: string; text: string }
    | { kind: "error"; reason: "incomplete" | "unavailable" | "mismatch" | Refusal };

export function SendReader({ accessId }: { accessId: string }) {
    const t = useTranslations("publicPages");
    const [state, setState] = useState<State>({ kind: "loading" });
    const [password, setPassword] = useState("");
    const [checking, setChecking] = useState(false);
    const [copied, setCopied] = useState(false);

    const open = useCallback(
        async (secret?: string) => {
            restoreParkedKey(accessId);
            const urlKey = keyFromFragment();
            if (!urlKey) {
                setState({ kind: "error", reason: "incomplete" });
                return;
            }
            const response = await fetch(
                `/vault/api/sends/access/${encodeURIComponent(accessId)}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        password: secret ? await crypto.sendPasswordHash(secret, urlKey) : null
                    })
                }
            );
            if (response.status === 401) {
                setState({ kind: "password" });
                return;
            }
            // The owner limited where, when or for whom it opens, and this
            // reader is outside it. The header (lib/vault/api/sends.ts) says which.
            if (response.status === 403) {
                const named = response.headers.get("x-polaris-send-refusal") ?? "";
                setState({
                    kind: "error",
                    reason: REFUSALS[named as keyof typeof REFUSALS] ?? "blocked"
                });
                return;
            }
            if (!response.ok) {
                setState({ kind: "error", reason: "unavailable" });
                return;
            }

            const body = (await response.json()) as {
                name?: string;
                text?: { text?: string } | null;
            };
            const sendKey = await crypto.deriveSendKey(urlKey);
            const name = body.name ? ((await crypto.decrypt(body.name, sendKey)) ?? "") : "";
            const text = body.text?.text
                ? ((await crypto.decrypt(body.text.text, sendKey)) ?? "")
                : "";
            if (!text) {
                setState({ kind: "error", reason: "mismatch" });
                return;
            }
            setState({ kind: "open", name, text });
        },
        [accessId]
    );

    useEffect(() => {
        void open();
    }, [open]);

    return (
        <PublicShell className="max-w-xl">
            {state.kind === "loading" ? (
                <Card>
                    <CardBody className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {t("send.opening")}
                    </CardBody>
                </Card>
            ) : null}

            {state.kind === "password" ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Lock className="size-4" />
                            {t("send.passwordTitle")}
                        </CardTitle>
                    </CardHeader>
                    <CardBody>
                        <form
                            className="flex flex-col gap-3"
                            onSubmit={async (event) => {
                                event.preventDefault();
                                setChecking(true);
                                await open(password);
                                setChecking(false);
                            }}
                        >
                            <p className="text-sm text-muted-foreground">
                                {t("send.passwordHint")}
                            </p>
                            <Input
                                type="password"
                                autoFocus
                                required
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                placeholder={t("send.password")}
                                aria-label={t("send.password")}
                            />
                            <Button type="submit" disabled={checking || !password}>
                                {checking ? t("send.checking") : t("send.open")}
                            </Button>
                        </form>
                    </CardBody>
                </Card>
            ) : null}

            {state.kind === "error" ? (
                <Card>
                    <CardBody className="flex flex-col items-center gap-4 p-8 text-center text-sm text-muted-foreground">
                        <p>{t(FAILURE_WORDS[state.reason])}</p>
                        {state.reason === "signIn" || state.reason === "notInvited" ? (
                            <Button asChild>
                                <Link
                                    href={`${signInHref(`/vs/${accessId}`)}${state.reason === "notInvited" ? "&add=1" : ""}`}
                                    onClick={() => parkKey(accessId)}
                                >
                                    <LogIn className="size-4" />
                                    {state.reason === "notInvited"
                                        ? t("send.anotherAccount")
                                        : t("send.signInButton")}
                                </Link>
                            </Button>
                        ) : null}
                    </CardBody>
                </Card>
            ) : null}

            {state.kind === "open" ? (
                <Card>
                    <CardHeader>
                        <CardTitle>{state.name || t("send.untitled")}</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-3">
                        <pre className="max-h-[50vh] overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-3 font-mono text-xs">
                            {state.text}
                        </pre>
                        <div className="flex justify-end">
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={async () => {
                                    await navigator.clipboard.writeText(state.text);
                                    setCopied(true);
                                }}
                            >
                                {copied ? (
                                    <Check className="size-4 text-success" />
                                ) : (
                                    <Copy className="size-4" />
                                )}
                                {t("send.copy")}
                            </Button>
                        </div>
                        <p className="text-center text-xs text-muted-foreground">
                            {t("send.footer")}
                        </p>
                    </CardBody>
                </Card>
            ) : null}
        </PublicShell>
    );
}

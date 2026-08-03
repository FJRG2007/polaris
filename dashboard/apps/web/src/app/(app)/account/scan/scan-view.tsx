"use client";

/**
 * Reading a sign-in code and deciding on it.
 *
 * Three ways in, one answer. The camera here decodes the QR; the phone's own
 * camera opens the same link and lands on this screen with the code already in
 * the address; and the code printed under the QR can be typed when neither is
 * available - the sign-in screen may be published on an address this device
 * cannot reach, and a camera needs a secure connection the LAN name does not
 * always have.
 *
 * Allowing a sign-in costs the quick-unlock PIN. An unlocked dashboard somebody
 * walked up to must not be enough to sign in a device they are holding, which is
 * the same reason the approval on Account > Sessions asks for it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { decideQrSignInAction } from "./actions";
import { RelativeTime } from "@/components/relative-time";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { Camera, Check, ShieldQuestion, X } from "lucide-react";
import type { QrSignInRequest } from "@/lib/qr-sign-in-service";
import { useEffect, useRef, useState, type FormEvent } from "react";

/** How often the camera frame is examined. Fast enough to feel instant, slow
 *  enough to leave a phone's battery alone. */
const SCAN_INTERVAL_MS = 200;

export function ScanView({
    request,
    scanned,
    hasPin
}: {
    request: QrSignInRequest | null;
    /** Whether a code was in the address at all, so a dead one can say so. */
    scanned: boolean;
    hasPin: boolean;
}) {
    if (request) return <DecideCard request={request} hasPin={hasPin} />;
    return <ReadCard stale={scanned} />;
}

/** Pull the code out of whatever the camera read: the link the QR encodes, or
 *  the bare code if somebody generated one another way. */
function codeFromScan(text: string): string | null {
    try {
        const fromLink = new URL(text).searchParams.get("code");
        if (fromLink) return fromLink;
    } catch {
        // Not a URL; fall through to treating the payload as the code itself.
    }
    return /^[A-Za-z0-9-]{6,13}$/.test(text.trim()) ? text.trim() : null;
}

/** The camera, and the typed code for when it is not an option. */
function ReadCard({ stale }: { stale: boolean }) {
    const router = useRouter();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [scanning, setScanning] = useState(false);
    const [typed, setTyped] = useState("");
    const [error, setError] = useState<string | null>(null);

    function open(code: string) {
        router.push(`/account/scan?code=${encodeURIComponent(code)}`);
    }

    // The camera runs only while it is asked for, and its track is stopped on the
    // way out - a stream left open keeps the recording light on.
    useEffect(() => {
        if (!scanning) return;
        const video = videoRef.current;
        if (!video) return;
        let stream: MediaStream | null = null;
        let timer = 0;
        let live = true;

        async function start() {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: "environment" }
                });
                if (!live) return;
                video!.srcObject = stream;
                await video!.play();
            } catch {
                if (!live) return;
                setScanning(false);
                setError(
                    "The camera is not available here. Browsers only allow it over a secure (https) address - type the code instead."
                );
                return;
            }

            const { default: jsQR } = await import("jsqr");
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) return;

            timer = window.setInterval(() => {
                if (!video!.videoWidth) return;
                canvas.width = video!.videoWidth;
                canvas.height = video!.videoHeight;
                context.drawImage(video!, 0, 0, canvas.width, canvas.height);
                const frame = context.getImageData(0, 0, canvas.width, canvas.height);
                const found = jsQR(frame.data, frame.width, frame.height, {
                    inversionAttempts: "dontInvert"
                });
                const code = found ? codeFromScan(found.data) : null;
                if (code) {
                    window.clearInterval(timer);
                    open(code);
                }
            }, SCAN_INTERVAL_MS);
        }

        void start();
        return () => {
            live = false;
            window.clearInterval(timer);
            for (const track of stream?.getTracks() ?? []) track.stop();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scanning]);

    function onSubmit(event: FormEvent) {
        event.preventDefault();
        const code = codeFromScan(typed);
        if (!code) {
            setError("That is not a Polaris sign-in code.");
            return;
        }
        open(code);
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                {stale ? (
                    <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                        That code is no longer valid. Ask for a new one on the sign-in screen and scan it
                        again.
                    </p>
                ) : null}

                <div className="flex flex-col items-center gap-3">
                    <div className="grid aspect-square w-full max-w-xs place-items-center overflow-hidden rounded-lg border border-border bg-muted/40">
                        <video
                            ref={videoRef}
                            muted
                            playsInline
                            className={scanning ? "size-full object-cover" : "hidden"}
                        />
                        {scanning ? null : (
                            <Camera className="size-8 text-muted-foreground" aria-hidden />
                        )}
                    </div>
                    {scanning ? (
                        <Button variant="outline" onClick={() => setScanning(false)}>
                            Stop the camera
                        </Button>
                    ) : (
                        <Button onClick={() => setScanning(true)}>
                            <Camera className="size-4" />
                            Scan with the camera
                        </Button>
                    )}
                </div>

                <form onSubmit={onSubmit} className="flex flex-col gap-2 border-t border-border pt-4">
                    <label className="text-sm" htmlFor="qr-code">
                        Or type the code under the QR
                    </label>
                    <div className="flex gap-2">
                        <Input
                            id="qr-code"
                            placeholder="ABCD-1234"
                            autoComplete="off"
                            autoCapitalize="characters"
                            className="font-mono tracking-widest"
                            value={typed}
                            onChange={(event) => {
                                setTyped(event.target.value);
                                setError(null);
                            }}
                        />
                        <Button type="submit" disabled={typed.trim().length === 0}>
                            Continue
                        </Button>
                    </div>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </form>
            </CardBody>
        </Card>
    );
}

/** What is asking to be let in, and the PIN that lets it. */
function DecideCard({ request, hasPin }: { request: QrSignInRequest; hasPin: boolean }) {
    const [pin, setPin] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<"approved" | "denied" | null>(null);
    const [expired, setExpired] = useState(() => new Date(request.expiresAt) <= new Date());

    // A code lives a couple of minutes. Saying so beats leaving somebody typing a
    // PIN into a decision that stopped counting.
    useEffect(() => {
        if (done) return;
        const timer = window.setInterval(() => {
            if (new Date(request.expiresAt) <= new Date()) setExpired(true);
        }, 1000);
        return () => window.clearInterval(timer);
    }, [request.expiresAt, done]);

    async function decide(approve: boolean) {
        setBusy(true);
        setError(null);
        const result = await decideQrSignInAction({ userCode: request.userCode, approve, pin });
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setPin("");
        setDone(approve ? "approved" : "denied");
    }

    if (done) {
        return (
            <Card>
                <CardBody className="flex flex-col items-center gap-3 py-8 text-center">
                    {done === "approved" ? (
                        <Check className="size-8 text-success" aria-hidden />
                    ) : (
                        <X className="size-8 text-muted-foreground" aria-hidden />
                    )}
                    <p className="text-sm">
                        {done === "approved"
                            ? "That device is signed in. It may take a moment to move on."
                            : "That sign-in was refused."}
                    </p>
                    <Link
                        href="/account/scan"
                        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                        Scan another code
                    </Link>
                </CardBody>
            </Card>
        );
    }

    if (expired) {
        return (
            <Card>
                <CardBody className="flex flex-col items-center gap-3 py-8 text-center">
                    <p className="text-sm">This code has expired.</p>
                    <p className="text-xs text-muted-foreground">
                        Ask for a new one on the sign-in screen and scan it again.
                    </p>
                    <Link href="/account/scan">
                        <Button variant="outline">Scan again</Button>
                    </Link>
                </CardBody>
            </Card>
        );
    }

    return (
        <Card className="border-warning/40">
            <CardBody className="flex flex-col gap-4">
                <div className="flex items-start gap-3">
                    <ShieldQuestion className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">Allow this sign-in?</h2>
                        <p className="text-xs text-muted-foreground">
                            It gets in as you. Allow it only if it is you at that screen.
                        </p>
                    </div>
                </div>

                <dl className="grid gap-2 rounded-md border border-border p-3 text-sm">
                    <Detail label="Device" value={request.device} />
                    <Detail label="From" value={request.origin} />
                    {request.host ? <Detail label="Opened on" value={request.host} /> : null}
                    <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">Asked</dt>
                        <dd className="text-right">
                            <RelativeTime iso={request.requestedAt} />
                        </dd>
                    </div>
                </dl>

                {hasPin ? (
                    <label className="flex flex-col gap-1 text-sm">
                        Unlock PIN
                        <Input
                            type="password"
                            inputMode="numeric"
                            maxLength={6}
                            autoComplete="off"
                            value={pin}
                            onChange={(event) => setPin(event.target.value)}
                        />
                    </label>
                ) : (
                    <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                        Allowing a sign-in this way needs a quick unlock PIN.{" "}
                        <Link
                            href="/account/security"
                            className="underline underline-offset-2 hover:text-foreground"
                        >
                            Set one in Security
                        </Link>
                        , then scan the code again.
                    </p>
                )}

                {error ? <p className="text-sm text-danger">{error}</p> : null}

                <div className="flex justify-end gap-2">
                    <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
                        <X className="size-4" />
                        Refuse
                    </Button>
                    <Button disabled={busy || !hasPin || pin.length < 4} onClick={() => void decide(true)}>
                        <Check className="size-4" />
                        {busy ? "Checking..." : "Allow"}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

function Detail({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate text-right">{value}</dd>
        </div>
    );
}

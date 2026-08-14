"use client";

/**
 * Opening a text drop point: a link that asks somebody for an .env, a key, a
 * log - anything that is text rather than a file - and files what comes back
 * into your snippets.
 *
 * The link is shown once, here, with a copy button. Only its hash is stored, so
 * this is the moment to copy it; everything else about the drop point can be
 * changed afterwards on its own page.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { GeoPicker } from "@/components/geo-picker";
import { AccountInput } from "@/components/account-input";
import { DEFAULT_TEXT_REQUEST_MAX_LENGTH } from "@polaris/core";
import { createTextRequestAction } from "./text-request-actions";
import { Check, Copy, Loader2, MessageSquarePlus } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Textarea
} from "@polaris/ui";

/** Split a comma or space separated field into its entries. */
function entries(value: string): string[] {
    return value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

export function NewTextDropPointButton() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [requireLogin, setRequireLogin] = useState(false);
    const [allowSealed, setAllowSealed] = useState(false);
    const [countries, setCountries] = useState<string[]>([]);
    const [continents, setContinents] = useState<string[]>([]);

    function reset(): void {
        setUrl(null);
        setError(null);
        setCopied(false);
        setRequireLogin(false);
        setAllowSealed(false);
        setCountries([]);
        setContinents([]);
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const maxLength = String(form.get("maxLength") ?? "").trim();
        const maxSubmissions = String(form.get("maxSubmissions") ?? "").trim();
        const expiresAt = String(form.get("expiresAt") ?? "").trim();
        const password = String(form.get("password") ?? "").trim();

        setPending(true);
        setError(null);
        const result = await createTextRequestAction({
            title: String(form.get("title") ?? "").trim() || undefined,
            instructions: String(form.get("instructions") ?? "").trim() || undefined,
            requireLogin,
            allowSealed,
            password: password || undefined,
            maxLength: maxLength ? Number(maxLength) : DEFAULT_TEXT_REQUEST_MAX_LENGTH,
            maxSubmissions: maxSubmissions ? Number(maxSubmissions) : undefined,
            allowedUsers: entries(String(form.get("allowedUsers") ?? "")),
            allowedCidrs: entries(String(form.get("allowedCidrs") ?? "")),
            allowedCountries: countries,
            allowedContinents: continents,
            expiresAt: expiresAt || undefined
        });
        setPending(false);
        if (result.error || !result.url) {
            setError(result.error ?? "This drop point could not be opened.");
            return;
        }
        setUrl(result.url);
        router.refresh();
    }

    return (
        <>
            <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                    reset();
                    setOpen(true);
                }}
            >
                <MessageSquarePlus className="size-4" />
                Ask for text
            </Button>

            <Dialog
                open={open}
                onOpenChange={(next) => {
                    setOpen(next);
                    if (!next) reset();
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Ask somebody for text</DialogTitle>
                        <DialogDescription>
                            They get a page to paste into. What they send becomes one of your
                            snippets.
                        </DialogDescription>
                    </DialogHeader>

                    {url ? (
                        <div className="flex flex-col gap-3">
                            <p className="text-sm text-muted-foreground">
                                Send this link to whoever should fill it in. It is shown only once.
                            </p>
                            <div className="flex items-center gap-2">
                                <Input readOnly value={url} className="font-mono text-xs" />
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="secondary"
                                    title="Copy the link"
                                    aria-label="Copy the link"
                                    onClick={async () => {
                                        await navigator.clipboard.writeText(url);
                                        setCopied(true);
                                    }}
                                >
                                    {copied ? (
                                        <Check className="size-4 text-success" />
                                    ) : (
                                        <Copy className="size-4" />
                                    )}
                                </Button>
                            </div>
                            <div className="flex justify-end">
                                <Button type="button" onClick={() => setOpen(false)}>
                                    Done
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <form onSubmit={onSubmit} className="flex flex-col gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                Title
                                <Input
                                    name="title"
                                    placeholder="Named for you if you leave it blank"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                What to send
                                <Textarea
                                    name="instructions"
                                    rows={2}
                                    placeholder="Shown on the page, e.g. paste your .env here"
                                />
                            </label>
                            <div className="grid grid-cols-2 gap-3">
                                <label className="flex flex-col gap-1 text-sm">
                                    Max characters
                                    <Input
                                        name="maxLength"
                                        type="number"
                                        min="1"
                                        placeholder={String(DEFAULT_TEXT_REQUEST_MAX_LENGTH)}
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    Max submissions
                                    <Input
                                        name="maxSubmissions"
                                        type="number"
                                        min="1"
                                        placeholder="Unlimited"
                                    />
                                </label>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <label className="flex flex-col gap-1 text-sm">
                                    Password (optional)
                                    <Input
                                        name="password"
                                        type="password"
                                        placeholder="No password"
                                        autoComplete="off"
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    Closes
                                    <Input name="expiresAt" type="date" />
                                </label>
                            </div>
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    className="size-4"
                                    checked={requireLogin}
                                    onChange={(event) => setRequireLogin(event.target.checked)}
                                />
                                They must sign in to Polaris first
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Only these people (optional)
                                <AccountInput
                                    name="allowedUsers"
                                    multiple
                                    placeholder="username or email, comma separated"
                                    aria-label="People who may send to this drop point"
                                />
                                <span className="text-xs text-muted-foreground">
                                    Naming anybody means they have to sign in.
                                </span>
                            </label>
                            <label className="flex items-start gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    className="mt-0.5 size-4"
                                    checked={allowSealed}
                                    onChange={(event) => setAllowSealed(event.target.checked)}
                                />
                                <span>
                                    Let them seal it in their browser
                                    <span className="block text-xs text-muted-foreground">
                                        Then Polaris cannot read it either, and they have to send
                                        you the key separately. Off by default.
                                    </span>
                                </span>
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Restrict to IPs / ranges (optional)
                                <Input
                                    name="allowedCidrs"
                                    placeholder="e.g. 203.0.113.4, 10.0.0.0/24"
                                    autoComplete="off"
                                />
                            </label>
                            <div className="flex flex-col gap-1 text-sm">
                                Restrict by location (optional)
                                <GeoPicker
                                    countries={countries}
                                    continents={continents}
                                    onCountries={setCountries}
                                    onContinents={setContinents}
                                />
                            </div>
                            {error ? <p className="text-sm text-danger">{error}</p> : null}
                            <div className="mt-1 flex justify-end">
                                <Button type="submit" disabled={pending}>
                                    {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                                    Create the link
                                </Button>
                            </div>
                        </form>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}

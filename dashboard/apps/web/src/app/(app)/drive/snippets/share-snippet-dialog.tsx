"use client";

/**
 * How a snippet is shared: private, anyone with the link, or named people, plus
 * the limits that link carries - a password, an expiry, a view cap, burn after
 * reading, and where it may be opened from.
 *
 * Turning sharing on mints a fresh link and shows it once here with a copy
 * button. Re-opening a snippet that was revoked mints a new one too, so a link
 * somebody was told to forget never starts working again.
 */

import { GeoPicker } from "@/components/geo-picker";
import { shareSnippetAction } from "./snippet-actions";
import { AccountInput } from "@/components/account-input";
import { Check, Copy, Link2, Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

/** What the dialog needs to know about the snippet it is opened on. */
export interface SnippetSharing {
    id: string;
    title: string;
    visibility: string;
    burnAfterRead: boolean;
    maxViews: number | null;
    expiresAt: string | null;
}

const VISIBILITIES = [
    { value: "private", label: "Private - only you" },
    { value: "link", label: "Anyone with the link" },
    { value: "invite", label: "Named people, signed in" }
];

/** Split a comma or space separated field into its entries. */
function entries(value: string): string[] {
    return value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

export function ShareSnippetDialog({
    snippet,
    onOpenChange,
    onSaved
}: {
    snippet: SnippetSharing | null;
    onOpenChange: (open: boolean) => void;
    onSaved: (id: string, visibility: string) => void;
}) {
    const [visibility, setVisibility] = useState("link");
    const [burn, setBurn] = useState(false);
    const [countries, setCountries] = useState<string[]>([]);
    const [continents, setContinents] = useState<string[]>([]);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    // Re-seed every time the dialog opens on another snippet, so it never shows
    // the previous one's settings or, worse, the previous one's link.
    useEffect(() => {
        if (!snippet) return;
        setVisibility(snippet.visibility === "private" ? "link" : snippet.visibility);
        setBurn(snippet.burnAfterRead);
        setCountries([]);
        setContinents([]);
        setError(null);
        setUrl(null);
        setCopied(false);
    }, [snippet]);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!snippet) return;
        const form = new FormData(event.currentTarget);
        const password = String(form.get("password") ?? "").trim();
        const maxViews = String(form.get("maxViews") ?? "").trim();
        const expiresAt = String(form.get("expiresAt") ?? "").trim();
        const invited = entries(String(form.get("inviteUsers") ?? ""));

        if (visibility === "invite" && invited.length === 0) {
            setError("Name at least one person, or share it with anyone holding the link.");
            return;
        }

        setPending(true);
        setError(null);
        const result = await shareSnippetAction(snippet.id, {
            visibility,
            password: password || null,
            maxViews: maxViews ? Number(maxViews) : null,
            expiresAt: expiresAt || null,
            burnAfterRead: burn,
            inviteUsers: invited,
            allowedCidrs: entries(String(form.get("allowedCidrs") ?? "")),
            allowedCountries: countries,
            allowedContinents: continents
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        if (visibility === "private" || !result.url) {
            onSaved(snippet.id, visibility);
            return;
        }
        setUrl(result.url);
    }

    return (
        <Dialog open={snippet !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Share this snippet</DialogTitle>
                    <DialogDescription>{snippet?.title}</DialogDescription>
                </DialogHeader>

                {url ? (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            Anyone with this link can read the snippet under the limits you set.
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
                            <Button
                                type="button"
                                onClick={() => snippet && onSaved(snippet.id, visibility)}
                            >
                                Done
                            </Button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Who can open it
                            <Select
                                value={visibility}
                                onValueChange={setVisibility}
                                options={VISIBILITIES}
                                aria-label="Who can open it"
                            />
                        </label>

                        {visibility === "invite" ? (
                            <label className="flex flex-col gap-1 text-sm">
                                People
                                <AccountInput
                                    name="inviteUsers"
                                    multiple
                                    placeholder="username or email, comma separated"
                                    aria-label="People who may open it"
                                />
                            </label>
                        ) : null}

                        {visibility === "private" ? (
                            <p className="text-sm text-muted-foreground">
                                Any link this snippet has stops working.
                            </p>
                        ) : (
                            <>
                                <label className="flex flex-col gap-1 text-sm">
                                    Password (optional)
                                    <Input
                                        name="password"
                                        type="password"
                                        placeholder="No password"
                                        autoComplete="off"
                                    />
                                </label>
                                <div className="grid grid-cols-2 gap-3">
                                    <label className="flex flex-col gap-1 text-sm">
                                        Max views
                                        <Input
                                            name="maxViews"
                                            type="number"
                                            min="1"
                                            placeholder="Unlimited"
                                            disabled={burn}
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                        Expires
                                        <Input name="expiresAt" type="date" />
                                    </label>
                                </div>
                                <label className="flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        className="size-4"
                                        checked={burn}
                                        onChange={(event) => setBurn(event.target.checked)}
                                    />
                                    Delete the text once it has been read
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    Restrict to IPs / ranges (optional)
                                    <Input
                                        name="allowedCidrs"
                                        placeholder="e.g. 203.0.113.4, 10.0.0.0/24"
                                        autoComplete="off"
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        Comma or space separated. Empty means anyone with the link.
                                    </span>
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
                            </>
                        )}

                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="mt-1 flex justify-end">
                            <Button type="submit" disabled={pending}>
                                {pending ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <Link2 className="size-4" />
                                )}
                                {visibility === "private" ? "Make it private" : "Share"}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

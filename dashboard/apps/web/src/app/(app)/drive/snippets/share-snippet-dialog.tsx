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
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    { value: "private", label: "snippetShare.visibility.private" },
    { value: "link", label: "snippetShare.visibility.link" },
    { value: "invite", label: "snippetShare.visibility.invite" }
] as const satisfies readonly { value: string; label: NamespaceKey<"drive"> }[];

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
    const t = useTranslations("drive");
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
                    <DialogTitle>{t("snippetShare.shareThisSnippet")}</DialogTitle>
                    <DialogDescription>{snippet?.title}</DialogDescription>
                </DialogHeader>

                {url ? (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            {t("snippetShare.anyoneWithThisLinkCan")}
                        </p>
                        <div className="flex items-center gap-2">
                            <Input readOnly value={url} className="font-mono text-xs" />
                            <Button
                                type="button"
                                size="icon"
                                variant="secondary"
                                title={t("snippetShare.copyTheLink")}
                                aria-label={t("snippetShare.copyTheLink")}
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
                                {t("snippetShare.done")}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("snippetShare.whoCanOpenIt")}
                            <Select
                                value={visibility}
                                onValueChange={setVisibility}
                                options={VISIBILITIES.map((one) => ({ value: one.value, label: t(one.label) }))}
                                aria-label={t("snippetShare.whoCanOpenIt")}
                            />
                        </label>

                        {visibility === "invite" ? (
                            <label className="flex flex-col gap-1 text-sm">
                                {t("snippetShare.people")}
                                <AccountInput
                                    name="inviteUsers"
                                    multiple
                                    placeholder={t("snippetShare.usernameOrEmailCommaSeparated")}
                                    aria-label={t("snippetShare.peopleWhoMayOpenIt")}
                                />
                            </label>
                        ) : null}

                        {visibility === "private" ? (
                            <p className="text-sm text-muted-foreground">
                                {t("snippetShare.anyLinkThisSnippetHas")}
                            </p>
                        ) : (
                            <>
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("snippetShare.passwordOptional")}
                                    <Input
                                        name="password"
                                        type="password"
                                        placeholder={t("snippetShare.noPassword")}
                                        autoComplete="off"
                                    />
                                </label>
                                <div className="grid grid-cols-2 gap-3">
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("snippetShare.maxViews")}
                                        <Input
                                            name="maxViews"
                                            type="number"
                                            min="1"
                                            placeholder={t("snippetShare.unlimited")}
                                            disabled={burn}
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("snippetShare.expires")}
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
                                    {t("snippetShare.deleteTheTextOnceIt")}
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("snippetShare.restrictToIpsRangesOptional")}
                                    <Input
                                        name="allowedCidrs"
                                        placeholder={t("snippetShare.eG2030113")}
                                        autoComplete="off"
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        {t("snippetShare.commaOrSpaceSeparatedEmpty")}
                                    </span>
                                </label>
                                <div className="flex flex-col gap-1 text-sm">
                                    {t("snippetShare.restrictByLocationOptional")}
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
                                {visibility === "private" ? t("snippetShare.makeItPrivate") : t("snippetShare.share")}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

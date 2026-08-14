"use client";

/**
 * One text drop point: its link, what it has collected, and its rules.
 *
 * The settings form is the same set of guardrails the creation dialog offers,
 * because a rule you can only set once is a rule you get wrong once. Saving is
 * disabled until something actually differs from what was loaded.
 */

import Link from "next/link";
import { formatBytes } from "@polaris/core";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { GeoPicker } from "@/components/geo-picker";
import { useConfirm } from "@/components/confirm-dialog";
import { AccountInput } from "@/components/account-input";
import { useFormChanged } from "@/lib/use-form-changed";
import { useDisplayFormat } from "@/components/display-format";
import { ArrowLeft, Check, Copy, EyeOff, Loader2, Save } from "lucide-react";
import { revealTextRequestLinkAction, updateTextRequestAction } from "@/app/(app)/drive/drop-points/text-request-actions";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Textarea } from "@polaris/ui";

export interface CollectedRow {
    id: string;
    title: string;
    sealed: boolean;
    at: string;
    from: string | null;
    size: number;
}

export interface TextDropPointSettings {
    id: string;
    title: string;
    instructions: string | null;
    requireLogin: boolean;
    allowSealed: boolean;
    allowedUsers: string[];
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
    maxLength: number;
    maxSubmissions: number | null;
    hasPassword: boolean;
    startsAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    submissionCount: number;
}

/** Split a comma or space separated field into its entries. */
function entries(value: string): string[] {
    return value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

/** An ISO timestamp as the value a <input type="date"> wants. */
function asDateValue(iso: string | null): string {
    return iso ? iso.slice(0, 10) : "";
}

export function TextDropPointDetail({
    request,
    collected
}: {
    request: TextDropPointSettings;
    collected: CollectedRow[];
}) {
    const router = useRouter();
    const format = useDisplayFormat();
    const [countries, setCountries] = useState(request.allowedCountries);
    const [continents, setContinents] = useState(request.allowedContinents);
    const [requireLogin, setRequireLogin] = useState(request.requireLogin);
    const [allowSealed, setAllowSealed] = useState(request.allowSealed);
    const [pending, setPending] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [link, setLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [confirm, confirmDialog] = useConfirm();
    const { formProps, changed, commit } = useFormChanged();

    // The switches and the location picker are React state, not form fields, so
    // the form snapshot cannot see them: without this, turning one off and saving
    // would be refused as "nothing changed".
    const dirty =
        changed ||
        requireLogin !== request.requireLogin ||
        allowSealed !== request.allowSealed ||
        countries.join() !== request.allowedCountries.join() ||
        continents.join() !== request.allowedContinents.join();

    async function onCopyLink() {
        const result = await revealTextRequestLinkAction(request.id);
        if (result.error || !result.url) {
            await confirm({
                title: "No link to copy",
                description: result.error ?? "This drop point has no link.",
                alert: true
            });
            return;
        }
        setLink(result.url);
        await navigator.clipboard.writeText(result.url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
    }

    async function onSave(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const password = String(form.get("password") ?? "");
        const maxSubmissions = String(form.get("maxSubmissions") ?? "").trim();
        const expiresAt = String(form.get("expiresAt") ?? "").trim();

        setPending(true);
        setError(null);
        setSaved(false);
        const result = await updateTextRequestAction(request.id, {
            title: String(form.get("title") ?? "").trim() || undefined,
            instructions: String(form.get("instructions") ?? "").trim() || null,
            requireLogin,
            allowSealed,
            // An untouched password field leaves the password alone; clearing it
            // has to be deliberate, which is what the checkbox beside it is for.
            ...(password ? { password } : {}),
            ...(form.get("clearPassword") ? { password: null } : {}),
            maxLength: Number(form.get("maxLength")),
            maxSubmissions: maxSubmissions ? Number(maxSubmissions) : null,
            allowedUsers: entries(String(form.get("allowedUsers") ?? "")),
            allowedCidrs: entries(String(form.get("allowedCidrs") ?? "")),
            allowedCountries: countries,
            allowedContinents: continents,
            expiresAt: expiresAt || null
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
        commit();
        router.refresh();
    }

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <Button asChild size="sm" variant="ghost" className="-ml-2 mb-1">
                        <Link href="/drive/drop-points">
                            <ArrowLeft className="size-4" />
                            Drop points
                        </Link>
                    </Button>
                    <h1 className="truncate text-lg font-semibold" title={request.title}>{request.title}</h1>
                    <p className="text-sm text-muted-foreground">
                        {request.submissionCount}
                        {request.maxSubmissions !== null ? `/${request.maxSubmissions}` : ""} collected
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {request.revokedAt ? <Badge variant="neutral">Closed</Badge> : null}
                    <Button size="sm" variant="secondary" onClick={onCopyLink}>
                        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                        Copy link
                    </Button>
                </div>
            </div>

            {link ? (
                <Input readOnly value={link} className="font-mono text-xs" aria-label="Drop point link" />
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle>Collected</CardTitle>
                </CardHeader>
                <CardBody className="p-0">
                    {collected.length === 0 ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">
                            Nothing has arrived yet.
                        </p>
                    ) : (
                        <ul className="divide-y divide-border">
                            {collected.map((row) => (
                                <li key={row.id}>
                                    <Link
                                        href={`/drive/snippets/${row.id}`}
                                        className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface"
                                    >
                                        <div className="min-w-0">
                                            <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                                                {row.title}
                                                {row.sealed ? (
                                                    <EyeOff
                                                        className="size-3 text-muted-foreground"
                                                        aria-label="Sealed"
                                                    />
                                                ) : null}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {row.from ?? "Anonymous"} - {formatBytes(row.size)} -{" "}
                                                {format.dateTime(row.at)}
                                            </p>
                                        </div>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Rules</CardTitle>
                </CardHeader>
                <CardBody>
                    <form {...formProps} onSubmit={onSave} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Title
                            <Input name="title" defaultValue={request.title} />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            What to send
                            <Textarea
                                name="instructions"
                                rows={2}
                                defaultValue={request.instructions ?? ""}
                            />
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                Max characters
                                <Input
                                    name="maxLength"
                                    type="number"
                                    min="1"
                                    defaultValue={request.maxLength}
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Max submissions
                                <Input
                                    name="maxSubmissions"
                                    type="number"
                                    min="1"
                                    placeholder="Unlimited"
                                    defaultValue={request.maxSubmissions ?? ""}
                                />
                            </label>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                {request.hasPassword ? "Change the password" : "Password (optional)"}
                                <Input
                                    name="password"
                                    type="password"
                                    placeholder={request.hasPassword ? "Unchanged" : "No password"}
                                    autoComplete="off"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Closes
                                <Input
                                    name="expiresAt"
                                    type="date"
                                    defaultValue={asDateValue(request.expiresAt)}
                                />
                            </label>
                        </div>
                        {request.hasPassword ? (
                            <label className="flex items-center gap-2 text-sm">
                                <input type="checkbox" name="clearPassword" className="size-4" />
                                Remove the password
                            </label>
                        ) : null}
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
                                defaultValue={request.allowedUsers.join(", ")}
                                placeholder="username or email, comma separated"
                                aria-label="People who may send to this drop point"
                            />
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
                                    Then Polaris cannot read it either, and they have to send you the
                                    key separately.
                                </span>
                            </span>
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Restrict to IPs / ranges (optional)
                            <Input
                                name="allowedCidrs"
                                defaultValue={request.allowedCidrs.join(", ")}
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
                        <div className="mt-1 flex items-center justify-end gap-2">
                            {saved ? (
                                <span className="text-xs text-muted-foreground">Saved</span>
                            ) : null}
                            <Button type="submit" disabled={pending || !dirty}>
                                {pending ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <Save className="size-4" />
                                )}
                                Save
                            </Button>
                        </div>
                    </form>
                </CardBody>
            </Card>
            {confirmDialog}
        </div>
    );
}

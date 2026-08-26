"use client";

/**
 * Making a key, and changing one, on a page of their own.
 *
 * It was a dialog, and a dialog is the wrong room for this. What a key may do is
 * the whole of the decision - thirty-five permissions today and more every time
 * Polaris grows an app - and a modal answers that by being scrolled inside a
 * scrolling page, with everything behind it dimmed and nothing to compare
 * against. A page has room for the sections to be sections, and it has an
 * address: editing a key is a place you can go back to, link somebody to, or
 * reload without losing what you typed into a box that closed.
 *
 * One component behind both, because everything except the secret can be changed
 * after a key exists and the fields are therefore the same fields. What differs
 * is what happens at the end: creating hands back a value that will never be
 * shown again, so the page stays put and shows it rather than navigating away
 * from it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ScopePicker } from "./scope-picker";
import { ArrowLeft, Copy, KeyRound } from "lucide-react";
import type { AccessGroupView, ApiKeyView } from "@polaris/auth";
import { createApiKeyAction, updateApiKeyAction } from "./actions";
import { Button, Card, CardBody, Input, Select, Textarea } from "@polaris/ui";
import { ClientRulesEditor, EMPTY_CLIENT_RULES } from "@/components/client-rules-editor";
import {
    AccessRulesEditor,
    EMPTY_ACCESS_RULES,
    type AccessRulesValue
} from "@/components/access-rules-editor";
import {
    API_KEY_DESCRIPTION_MAX,
    API_KEY_ENVIRONMENTS,
    API_KEY_ENVIRONMENT_LABELS,
    API_KEY_EXPIRY_CHOICES,
    expandPermissions,
    type ApiKeyEnvironment,
    type Permission,
    type UserAgentRules
} from "@polaris/core";

/** The Select value that swaps the fixed spans for a date of the user's choosing. */
const CUSTOM_EXPIRY = "custom";

/** And the one that leaves an existing key ending exactly when it already did.
 *  Only offered while editing, and the default there: renaming a key must not
 *  quietly move its expiry to whatever the form happened to show. */
const KEEP_EXPIRY = "keep";

function expiryLabel(days: number): string {
    return days === 0 ? "Never expires" : `${days} days`;
}

/** A picked day expires at the end of it, local time - the day itself still works. */
function endOfDay(date: string): Date | null {
    const [year, month, day] = date.split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, 23, 59, 59, 999);
}

/** Today, local time, as the earliest day a key may be set to expire on. */
function earliestExpiryDate(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
}

/** One titled block of the form. The sections are what a page buys over a
 *  dialog: each decision gets a heading and a sentence saying what it is for. */
function Section({
    title,
    hint,
    children
}: {
    title: string;
    hint: string;
    children: ReactNode;
}) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">{title}</h2>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                </div>
                {children}
            </CardBody>
        </Card>
    );
}

export function KeyForm({
    groups,
    availableScopes,
    /** The key being changed, or null on the page that mints one. */
    editing
}: {
    groups: AccessGroupView[];
    availableScopes: Permission[];
    editing: ApiKeyView | null;
}) {
    const router = useRouter();
    const [name, setName] = useState(editing?.name ?? "");
    const [description, setDescription] = useState(editing?.description ?? "");
    const [environment, setEnvironment] = useState<ApiKeyEnvironment>(
        editing?.environment ?? "production"
    );
    const [scopes, setScopes] = useState<Permission[]>((editing?.scopes as Permission[]) ?? []);
    const [expiry, setExpiry] = useState<string>(editing ? KEEP_EXPIRY : "90");
    const [expiryDate, setExpiryDate] = useState("");
    const [rules, setRules] = useState<AccessRulesValue>(
        editing
            ? {
                  groupIds: editing.groupIds,
                  allowedCidrs: editing.allowedCidrs,
                  allowedCountries: editing.allowedCountries,
                  allowedContinents: editing.allowedContinents
              }
            : EMPTY_ACCESS_RULES
    );
    const [clients, setClients] = useState<UserAgentRules>(
        editing
            ? {
                  allowedUserAgents: editing.allowedUserAgents,
                  deniedUserAgents: editing.deniedUserAgents
              }
            : EMPTY_CLIENT_RULES
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** The value, for the moment it exists. */
    const [issued, setIssued] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    /**
     * Leaving with a key on screen that has not been copied.
     *
     * The secret exists in this browser and nowhere else, so a closed tab is a
     * key nobody has. The browser's own "leave site?" prompt is the only thing
     * that can interrupt that, and it is only allowed to appear because
     * something genuinely unrecoverable is about to be lost.
     */
    useEffect(() => {
        if (!issued || copied) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [copied, issued]);

    const custom = expiry === CUSTOM_EXPIRY;
    const keeping = expiry === KEEP_EXPIRY;
    const chosenDate = custom ? endOfDay(expiryDate) : null;
    const dateReady = !custom || (chosenDate !== null && chosenDate.getTime() > Date.now());

    async function submit() {
        setBusy(true);
        setError(null);
        const shared = {
            name,
            description,
            environment,
            scopes: expandPermissions(scopes),
            ...rules,
            ...clients
        };

        if (editing) {
            const result = await updateApiKeyAction({
                ...shared,
                id: editing.id,
                // One of the three and never two. Left out entirely under
                // "keep", which is what tells the server the expiry is not part
                // of this edit - and a span sent beside a null date would read
                // as "never expires" and quietly undo the span that was chosen.
                ...(keeping
                    ? {}
                    : custom
                      ? { expiresAt: chosenDate?.toISOString() }
                      : { expiresInDays: Number(expiry) })
            });
            setBusy(false);
            if (result.error) {
                setError(result.error);
                return;
            }
            router.push("/account/api-keys");
            router.refresh();
            return;
        }

        const result = await createApiKeyAction({
            ...shared,
            expiresInDays: custom ? 0 : Number(expiry),
            expiresAt: chosenDate?.toISOString()
        });
        setBusy(false);
        if (result.error || !result.secret) {
            setError(result.error ?? "Could not create the key.");
            return;
        }
        setIssued(result.secret);
    }

    if (issued) {
        return (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
                <div>
                    <h1 className="text-[17px] font-semibold tracking-tight">{name}</h1>
                    <p className="text-sm text-muted-foreground">
                        Copy it now. Polaris stores only a hash of it and cannot show it again -
                        losing it means making another key.
                    </p>
                </div>
                <Card>
                    <CardBody className="flex flex-col gap-3">
                        <code className="break-all rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
                            {issued}
                        </code>
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button
                                variant="outline"
                                onClick={() => {
                                    void navigator.clipboard.writeText(issued).then(() => {
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 2000);
                                    });
                                }}
                            >
                                <Copy className="size-4" />
                                {copied ? "Copied" : "Copy"}
                            </Button>
                            <Button
                                onClick={() => {
                                    router.push("/account/api-keys");
                                    router.refresh();
                                }}
                            >
                                Done
                            </Button>
                        </div>
                    </CardBody>
                </Card>
            </div>
        );
    }

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div className="flex flex-col gap-1">
                <Link
                    href="/account/api-keys"
                    className="flex w-fit items-center gap-1 text-xs text-muted-foreground no-underline transition-colors hover:text-foreground"
                >
                    <ArrowLeft className="size-3.5" />
                    API keys
                </Link>
                <h1 className="text-[17px] font-semibold tracking-tight">
                    {editing ? editing.name : "New API key"}
                </h1>
                <p className="text-sm text-muted-foreground">
                    {editing
                        ? "Everything except the secret itself. Whatever is using this key keeps working."
                        : "A key acts as you, with a subset of your own permissions and only from where you allow."}
                </p>
            </div>

            <Section title="What it is" hint="How you will recognise this key in a year.">
                <div className="flex flex-col gap-4 sm:flex-row">
                    <label className="flex flex-1 flex-col gap-1 text-sm">
                        Name
                        <Input
                            value={name}
                            placeholder="Backup script"
                            autoComplete="off"
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm sm:w-48">
                        Environment
                        <Select
                            value={environment}
                            onValueChange={(value) => setEnvironment(value as ApiKeyEnvironment)}
                            options={API_KEY_ENVIRONMENTS.map((value) => ({
                                value,
                                label: API_KEY_ENVIRONMENT_LABELS[value]
                            }))}
                        />
                    </label>
                </div>
                <label className="flex flex-col gap-1 text-sm">
                    Description
                    <Textarea
                        value={description}
                        rows={2}
                        maxLength={API_KEY_DESCRIPTION_MAX}
                        placeholder="What this key is for, and what would break without it."
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </label>
                <p className="text-xs text-muted-foreground">
                    The environment is a label for sorting your own keys. Both reach the same
                    Polaris.
                </p>
            </Section>

            <Section
                title="Expiry"
                hint="A key that never expires is a key nobody ever reviews."
            >
                <div className="flex flex-col gap-2 sm:max-w-sm">
                    <Select
                        value={expiry}
                        onValueChange={setExpiry}
                        aria-label="Expiry"
                        options={[
                            ...(editing ? [{ value: KEEP_EXPIRY, label: "Leave as it is" }] : []),
                            ...API_KEY_EXPIRY_CHOICES.map((days) => ({
                                value: String(days),
                                label: expiryLabel(days)
                            })),
                            { value: CUSTOM_EXPIRY, label: "Custom date" }
                        ]}
                    />
                    {custom ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="text-xs text-muted-foreground">
                                Works through the end of the chosen day.
                            </span>
                            <Input
                                type="date"
                                value={expiryDate}
                                min={earliestExpiryDate()}
                                onChange={(event) => setExpiryDate(event.target.value)}
                            />
                        </label>
                    ) : null}
                </div>
            </Section>

            <Section
                title="Permissions"
                hint="A key can never do more than you can, whatever is ticked here."
            >
                <ScopePicker available={availableScopes} selected={scopes} onChange={setScopes} />
            </Section>

            <Section
                title="Where it may be used"
                hint="Addresses and places the key is answered from. Left empty, it works from anywhere you do."
            >
                <AccessRulesEditor value={rules} groups={groups} onChange={setRules} />
            </Section>

            <Section
                title="What may use it"
                hint="The clients allowed to present it. A blocked one is refused whatever the allow list says."
            >
                <ClientRulesEditor value={clients} onChange={setClients} />
            </Section>

            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 pb-2">
                <Button variant="ghost" onClick={() => router.push("/account/api-keys")}>
                    Cancel
                </Button>
                <Button
                    onClick={() => void submit()}
                    disabled={busy || name.trim() === "" || scopes.length === 0 || !dateReady}
                >
                    <KeyRound className="size-4" />
                    {busy
                        ? editing
                            ? "Saving..."
                            : "Creating..."
                        : editing
                          ? "Save changes"
                          : "Create key"}
                </Button>
            </div>
        </div>
    );
}

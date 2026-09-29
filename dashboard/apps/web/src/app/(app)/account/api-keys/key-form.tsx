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
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
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

function expiryLabel(days: number, t: NamespaceTranslator<"account">): string {
    return days === 0 ? t("apiKeys.form.neverExpires") : t("apiKeys.form.days", { count: days });
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
    const t = useTranslations("account");
    const tc = useTranslations("common");
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
            setError(result.error ?? t("apiKeys.form.createFailed"));
            return;
        }
        setIssued(result.secret);
    }

    if (issued) {
        return (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">{name}</h1>
                    <p className="text-sm text-muted-foreground">{t("apiKeys.form.copyNow")}</p>
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
                                {copied ? t("apiKeys.form.copied") : t("apiKeys.form.copy")}
                            </Button>
                            <Button
                                onClick={() => {
                                    router.push("/account/api-keys");
                                    router.refresh();
                                }}
                            >
                                {t("apiKeys.form.done")}
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
                    {t("apiKeys.page.title")}
                </Link>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {editing ? editing.name : t("apiKeys.form.newTitle")}
                </h1>
                <p className="text-sm text-muted-foreground">
                    {editing ? t("apiKeys.form.editIntro") : t("apiKeys.form.newIntro")}
                </p>
            </div>

            <Section title={t("apiKeys.form.what.title")} hint={t("apiKeys.form.what.hint")}>
                <div className="flex flex-col gap-4 sm:flex-row">
                    <label className="flex flex-1 flex-col gap-1 text-sm">
                        {t("apiKeys.list.columns.name")}
                        <Input
                            value={name}
                            placeholder={t("apiKeys.form.namePlaceholder")}
                            autoComplete="off"
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm sm:w-48">
                        {t("apiKeys.list.environment")}
                        <Select
                            value={environment}
                            onValueChange={(value) => setEnvironment(value as ApiKeyEnvironment)}
                            options={API_KEY_ENVIRONMENTS.map((value) => ({
                                value,
                                label: t(`apiKeys.environments.${value}` as const)
                            }))}
                        />
                    </label>
                </div>
                <label className="flex flex-col gap-1 text-sm">
                    {t("apiKeys.form.description")}
                    <Textarea
                        value={description}
                        rows={2}
                        maxLength={API_KEY_DESCRIPTION_MAX}
                        placeholder={t("apiKeys.form.descriptionPlaceholder")}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </label>
                <p className="text-xs text-muted-foreground">{t("apiKeys.form.environmentHint")}</p>
            </Section>

            <Section
                title={t("apiKeys.list.expiryLabel")}
                hint={t("apiKeys.form.expiryHint")}
            >
                <div className="flex flex-col gap-2 sm:max-w-sm">
                    <Select
                        value={expiry}
                        onValueChange={setExpiry}
                        aria-label={t("apiKeys.list.expiryLabel")}
                        options={[
                            ...(editing ? [{ value: KEEP_EXPIRY, label: t("apiKeys.form.keepExpiry") }] : []),
                            ...API_KEY_EXPIRY_CHOICES.map((days) => ({
                                value: String(days),
                                label: expiryLabel(days, t)
                            })),
                            { value: CUSTOM_EXPIRY, label: t("apiKeys.form.customDate") }
                        ]}
                    />
                    {custom ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="text-xs text-muted-foreground">{t("apiKeys.form.endOfDay")}</span>
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
                title={t("apiKeys.form.permissions.title")}
                hint={t("apiKeys.form.permissions.hint")}
            >
                <ScopePicker available={availableScopes} selected={scopes} onChange={setScopes} />
            </Section>

            <Section
                title={t("apiKeys.form.where.title")}
                hint={t("apiKeys.form.where.hint")}
            >
                <AccessRulesEditor value={rules} groups={groups} onChange={setRules} />
            </Section>

            <Section
                title={t("apiKeys.form.clients.title")}
                hint={t("apiKeys.form.clients.hint")}
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
                    {tc("actions.cancel")}
                </Button>
                <Button
                    onClick={() => void submit()}
                    disabled={busy || name.trim() === "" || scopes.length === 0 || !dateReady}
                >
                    <KeyRound className="size-4" />
                    {busy
                        ? editing
                            ? tc("actions.saving")
                            : t("apiKeys.form.creating")
                        : editing
                          ? t("apiKeys.form.saveChanges")
                          : t("apiKeys.form.create")}
                </Button>
            </div>
        </div>
    );
}

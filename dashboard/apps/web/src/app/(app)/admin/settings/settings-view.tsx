"use client";

/**
 * General settings client view: where this deployment answers, and the public
 * pages. Updates and seasonal themes have screens of their own.
 */

import { normalizeLegalContact } from "@polaris/core";
import { FactRow as Row } from "./fact-row";
import { saveLegalContactAction } from "./actions";
import { useSettingsOverview } from "./use-overview";
import type { PublicUrls } from "@/lib/legal/service";
import { AddressList } from "@/components/address-list";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useState, useTransition } from "react";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Skeleton } from "@polaris/ui";

/** The facts that come from the environment, which the server already has when
 *  it renders the page. */
interface Deployment {
    readonly hostname: string;
    readonly repo: string;
    readonly branch: string;
}

/** The parts of the overview this screen draws. */
const DEPLOYMENT_PARTS = ["addresses", "network"] as const;

export function SettingsView({
    initialContact,
    publicPages,
    deployment
}: {
    initialContact: string;
    publicPages: PublicUrls;
    deployment: Deployment;
}) {
    const t = useTranslations("admin");
    const { addresses, setAddresses, network } = useSettingsOverview(DEPLOYMENT_PARTS);

    return (
        <div className="flex w-full flex-col gap-4">
            <Card>
                <CardHeader>
                    <CardTitle>{t("settings.deployment.title")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm text-muted-foreground">
                            {t("settings.deployment.reachableAt")}
                        </span>
                        {addresses ? (
                            <AddressList
                                addresses={addresses}
                                onChanged={setAddresses}
                                manageHref="/admin/domains"
                            />
                        ) : (
                            // Shaped like the rows it will become: a list of
                            // addresses, each with its verdict beside it.
                            <div className="flex flex-col gap-1.5">
                                <Skeleton className="h-8 w-full" />
                                <Skeleton className="h-8 w-4/5" />
                            </div>
                        )}
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Row
                            label={t("settings.deployment.localHostname")}
                            value={`${deployment.hostname}.local`}
                        />
                        <Row
                            label={t("settings.deployment.serverIp")}
                            value={
                                network
                                    ? (network.serverIp ?? t("settings.deployment.unknown"))
                                    : null
                            }
                        />
                        <Row
                            label={t("settings.deployment.publicIp")}
                            value={
                                network
                                    ? (network.publicIp ?? t("settings.deployment.notDetected"))
                                    : null
                            }
                        />
                        <Row
                            label={t("settings.deployment.repository")}
                            value={deployment.repo}
                            href={`https://github.com/${deployment.repo}`}
                        />
                        <Row label={t("settings.deployment.branch")} value={deployment.branch} />
                    </dl>
                </CardBody>
            </Card>

            <PublicPagesCard initialContact={initialContact} pages={publicPages} />
        </div>
    );
}

/**
 * The three pages that exist outside the login, and the one line on them this
 * deployment gets to write.
 *
 * Here rather than buried in the Integrations screen because they are not about
 * one provider: Google's verification reads all three, Epic's brand review reads
 * two, and an operator who has just been refused by either needs to find them by
 * name. The URLs are shown ready to copy for exactly that - they are what those
 * forms ask for, and typing them from memory is how a review fails on a
 * mistyped path.
 */
function PublicPagesCard({ initialContact, pages }: { initialContact: string; pages: PublicUrls }) {
    const [contact, setContact] = useState(initialContact);
    const [saved, setSaved] = useState(initialContact);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const t = useTranslations("admin");
    const tc = useTranslations("common");

    // Nothing to save when it comes back to what is stored: a value edited and
    // put back is not a change.
    const dirty = normalizeLegalContact(contact) !== saved;

    function onSave() {
        const next = normalizeLegalContact(contact);
        setError(null);
        startTransition(async () => {
            const result = await saveLegalContactAction(next);
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved(result.contact ?? "");
            setContact(result.contact ?? "");
        });
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("settings.publicPages.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">{t("settings.publicPages.intro")}</p>

                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <Row
                        label={t("settings.publicPages.home")}
                        value={pages.home}
                        href={pages.home}
                    />
                    <Row
                        label={t("settings.publicPages.privacy")}
                        value={pages.privacy}
                        href={pages.privacy}
                    />
                    <Row
                        label={t("settings.publicPages.terms")}
                        value={pages.terms}
                        href={pages.terms}
                    />
                </dl>

                <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">{t("settings.publicPages.contact")}</span>
                    <div className="flex items-center gap-2">
                        <Input
                            value={contact}
                            onChange={(event) => setContact(event.target.value)}
                            placeholder="you@example.com"
                            autoComplete="off"
                            aria-label={t("settings.publicPages.contactLabel")}
                        />
                        <Button size="sm" onClick={onSave} disabled={pending || !dirty}>
                            {pending ? tc("actions.saving") : tc("actions.save")}
                        </Button>
                    </div>
                    <span className="text-xs text-muted-foreground">
                        {t("settings.publicPages.contactHint")}
                    </span>
                    {error ? <span className="text-xs text-danger">{error}</span> : null}
                </label>
            </CardBody>
        </Card>
    );
}

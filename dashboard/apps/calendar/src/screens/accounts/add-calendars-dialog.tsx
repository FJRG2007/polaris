"use client";

/**
 * "Add calendars" from the calendar's sidebar: subscribe by address, a public
 * holiday calendar (or one the operator suggests), or the way to the accounts
 * screen where Google, Microsoft and CalDAV are linked.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCalendarT } from "../i18n";
import { SubscriptionsOff } from "./accounts-view";
import type { AddCalendarsSlotProps } from "../slots";
import { loadInstanceSettingsAction } from "../../actions/instance";
import type { InstanceSettings } from "../../lib/instance-settings";
import { FeedForm, HolidayPicker, SuggestedCalendars } from "./forms";
import { cacheKey, dropCached, unwrap, useCachedRead } from "../cached-read";
import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    SegmentedControl
} from "@polaris/ui";

type Tab = "subscribe" | "holidays" | "accounts";

export function AddCalendarsDialog({
    open,
    tab: initialTab = "subscribe",
    onOpenChange,
    onChanged
}: AddCalendarsSlotProps) {
    const t = useCalendarT();
    const [tab, setTab] = useState<Tab>(initialTab);
    // Each opening starts on the tab it was opened for.
    useEffect(() => {
        if (open) setTab(initialTab);
    }, [open, initialTab]);
    const instance = useCachedRead<{ settings: InstanceSettings; canManage: boolean }>(
        open ? cacheKey("instance") : null,
        () =>
            unwrap(() => loadInstanceSettingsAction(), t("errors.generic")).then((answer) => ({
                settings: answer.settings,
                canManage: answer.canManage
            }))
    );
    const allow = instance.data?.settings.allowSubscriptions ?? true;

    function added(): void {
        dropCached("accounts");
        onChanged();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("accounts.addDialog.title")}</DialogTitle>
                </DialogHeader>
                <SegmentedControl<Tab>
                    value={tab}
                    onValueChange={setTab}
                    aria-label={t("accounts.addDialog.title")}
                    options={[
                        { value: "subscribe", label: t("accounts.addDialog.subscribe") },
                        { value: "holidays", label: t("accounts.addDialog.holidays") },
                        { value: "accounts", label: t("accounts.addDialog.accounts") }
                    ]}
                />
                <div className="pt-2">
                    {tab === "accounts" ? (
                        <div className="flex flex-col gap-3">
                            <p className="text-muted-foreground">
                                {t("accounts.addDialog.accountsLead")}
                            </p>
                            <div>
                                <Button asChild variant="outline">
                                    <Link
                                        href="/calendar/settings/accounts"
                                        onClick={() => onOpenChange(false)}
                                    >
                                        {t("accounts.addDialog.openAccounts")}
                                    </Link>
                                </Button>
                            </div>
                        </div>
                    ) : !allow ? (
                        <SubscriptionsOff canManage={instance.data?.canManage ?? false} />
                    ) : tab === "subscribe" ? (
                        <div className="flex flex-col gap-2">
                            <p className="text-xs text-foreground-subtle">
                                {t("accounts.feed.lead")}
                            </p>
                            <FeedForm onAdded={added} />
                        </div>
                    ) : (
                        <div className="flex flex-col gap-4">
                            {instance.data ? (
                                <SuggestedCalendars
                                    suggested={instance.data.settings.suggested}
                                    onAdded={added}
                                />
                            ) : null}
                            <HolidayPicker onAdded={added} />
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

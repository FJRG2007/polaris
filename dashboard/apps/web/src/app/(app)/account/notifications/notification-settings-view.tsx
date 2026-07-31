"use client";

/**
 * Where each kind of alert is sent. One row per event, grouped by the part of
 * Polaris it comes from; each row is a set of toggles rather than a single
 * choice, because "the bell and a Discord channel" is the common case and a
 * dropdown would force a false choice between them.
 *
 * A row with nothing selected reads "Muted", which is a state worth naming: it
 * is the difference between an alert that went nowhere on purpose and one that
 * failed to send.
 */

import { useState, useTransition } from "react";
import { AlertTriangle, Bell, Mail, Smartphone, Webhook } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, CardTitle, cn } from "@polaris/ui";
import {
    isMuted,
    NOTIFICATION_EVENTS,
    NOTIFICATION_GROUPS,
    NOTIFICATION_GROUP_LABEL,
    type NotificationGroup,
    type NotificationRule
} from "@polaris/core";
import type { DeliveryView } from "@/lib/notification-service";
import type { DestinationView } from "@/lib/notifications/destinations";
import type { SmsSenderView } from "@/lib/notifications/sms-service";
import { DestinationsCard } from "./destinations-card";
import { SmsSenderCard } from "./sms-sender-card";
import { DeliveryLog } from "./delivery-log";
import { saveNotificationRuleAction } from "./actions";

export function NotificationSettingsView({
    rules,
    destinations,
    senders,
    deliveries
}: {
    rules: Array<{ event: string; rule: NotificationRule }>;
    destinations: DestinationView[];
    senders: SmsSenderView[];
    deliveries: DeliveryView[];
}) {
    const [state, setState] = useState(() => new Map(rules.map((entry) => [entry.event, entry.rule])));
    const [error, setError] = useState<string | null>(null);
    const [, startSaving] = useTransition();

    /** Apply a rule change at once and put it back if the server refuses it. */
    function update(event: string, next: NotificationRule) {
        const previous = state.get(event);
        setState((current) => new Map(current).set(event, next));
        setError(null);
        startSaving(async () => {
            const result = await saveNotificationRuleAction({ event, rule: next });
            if (result.error) {
                setError(result.error);
                if (previous) setState((current) => new Map(current).set(event, previous));
            }
        });
    }

    const groups = NOTIFICATION_GROUPS.filter((group) =>
        NOTIFICATION_EVENTS.some((entry) => entry.group === group)
    );

    return (
        <div className="flex flex-col gap-4">
            {error ? (
                <p className="flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                    <AlertTriangle className="size-4 shrink-0" />
                    {error}
                </p>
            ) : null}

            {groups.map((group) => (
                <EventGroup
                    key={group}
                    group={group}
                    state={state}
                    destinations={destinations}
                    onChange={update}
                />
            ))}

            <DestinationsCard destinations={destinations} smsReady={senders.some((s) => s.status === "connected")} />
            <SmsSenderCard senders={senders} />
            <DeliveryLog deliveries={deliveries} />
        </div>
    );
}

function EventGroup({
    group,
    state,
    destinations,
    onChange
}: {
    group: NotificationGroup;
    state: Map<string, NotificationRule>;
    destinations: DestinationView[];
    onChange: (event: string, rule: NotificationRule) => void;
}) {
    const events = NOTIFICATION_EVENTS.filter((entry) => entry.group === group);

    return (
        <Card>
            <CardHeader>
                <CardTitle>{NOTIFICATION_GROUP_LABEL[group]}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 p-0">
                <ul className="divide-y divide-border">
                    {events.map((entry) => {
                        const rule = state.get(entry.id);
                        if (!rule) return null;
                        return (
                            <li key={entry.id} className="flex flex-col gap-2 px-4 py-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium">{entry.label}</p>
                                        <p className="text-xs text-muted-foreground">{entry.description}</p>
                                    </div>
                                    {isMuted(rule) ? <Badge>Muted</Badge> : null}
                                </div>
                                <RuleChips
                                    eventId={entry.id}
                                    rule={rule}
                                    critical={entry.critical === true}
                                    destinations={destinations}
                                    onChange={onChange}
                                />
                            </li>
                        );
                    })}
                </ul>
            </CardBody>
        </Card>
    );
}

/** The delivery toggles for one event, as chips that read as on or off. */
function RuleChips({
    eventId,
    rule,
    critical,
    destinations,
    onChange
}: {
    eventId: string;
    rule: NotificationRule;
    critical: boolean;
    destinations: DestinationView[];
    onChange: (event: string, rule: NotificationRule) => void;
}) {
    function toggleDestination(id: string) {
        const on = rule.destinations.includes(id);
        onChange(eventId, {
            ...rule,
            destinations: on ? rule.destinations.filter((entry) => entry !== id) : [...rule.destinations, id]
        });
    }

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <Chip
                icon={Bell}
                label="In-app"
                on={rule.inapp}
                // A security alert always leaves a record; only where else it goes
                // is negotiable.
                disabled={critical}
                title={critical ? "Security alerts always appear in Polaris" : undefined}
                onClick={() => onChange(eventId, { ...rule, inapp: !rule.inapp })}
            />
            <Chip
                icon={Mail}
                label="Email"
                on={rule.email}
                onClick={() => onChange(eventId, { ...rule, email: !rule.email })}
            />
            {destinations.map((destination) => (
                <Chip
                    key={destination.id}
                    icon={destination.kind === "sms" ? Smartphone : Webhook}
                    label={destination.name}
                    on={rule.destinations.includes(destination.id)}
                    disabled={!destination.enabled}
                    title={destination.enabled ? destination.targetHint : "This destination is switched off"}
                    onClick={() => toggleDestination(destination.id)}
                />
            ))}
        </div>
    );
}

function Chip({
    icon: Icon,
    label,
    on,
    disabled,
    title,
    onClick
}: {
    icon: typeof Webhook;
    label: string;
    on: boolean;
    disabled?: boolean;
    title?: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            aria-pressed={on}
            className={cn(
                "inline-flex max-w-48 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on
                    ? "border-transparent bg-primary/15 text-primary"
                    : "border-border bg-muted text-muted-foreground hover:text-foreground",
                disabled && "cursor-not-allowed opacity-60 hover:text-muted-foreground"
            )}
        >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{label}</span>
        </button>
    );
}

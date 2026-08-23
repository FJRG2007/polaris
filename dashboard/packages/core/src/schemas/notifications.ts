/**
 * What Polaris can tell you about, and how it is allowed to reach you.
 *
 * One catalogue of events, shared by the code that raises them, the settings
 * page that lists them, and the dispatcher that routes them - so an event is
 * described in exactly one place and nothing can raise an alert nobody can
 * turn off or find.
 *
 * A rule is per event and additive: an event can go nowhere, to the bell, to
 * mail, or to any number of destinations at once. Nothing selected means muted,
 * which is a deliberate choice rather than a broken configuration - except for
 * the events marked `critical`, which always reach the bell, because an account
 * that quietly muted its own break-in alert is not a setting anyone wants.
 */

import { z } from "zod";

/** How an alert can travel. `inapp` and `email` are built in; the other two
 *  need a destination the account added. */
export const NOTIFICATION_DELIVERY_KINDS = ["inapp", "email", "webhook", "sms"] as const;

export type NotificationDeliveryKind = (typeof NOTIFICATION_DELIVERY_KINDS)[number];

/** The kinds a destination row can be. Mail and the bell need no destination. */
export const NOTIFICATION_DESTINATION_KINDS = ["webhook", "sms"] as const;

export type NotificationDestinationKind = (typeof NOTIFICATION_DESTINATION_KINDS)[number];

/**
 * How a webhook body is shaped. Discord and Slack each want their own JSON;
 * `generic` posts the raw event, which is what a script or a bridge of your own
 * wants. `auto` picks by hostname when the destination is added.
 */
export const WEBHOOK_FORMATS = ["discord", "slack", "generic"] as const;

export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** The groups the settings page renders events under. */
export const NOTIFICATION_GROUPS = [
    "deploy",
    "watch",
    "tasks",
    "security",
    "drive",
    "places",
    "network",
    "people",
    "system"
] as const;

export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

export const NOTIFICATION_GROUP_LABEL: Record<NotificationGroup, string> = {
    deploy: "Deploy",
    watch: "Watch",
    tasks: "Tasks",
    security: "Security",
    drive: "Drive",
    places: "Places",
    network: "Network",
    people: "People",
    system: "Polaris"
};

/** Styling severity, mirrored by the in-app row and the webhook colour. */
export type NotificationLevel = "info" | "success" | "warning" | "danger";

/** One thing Polaris can tell you about. */
export interface NotificationEventInfo {
    id: string;
    group: NotificationGroup;
    label: string;
    /** One line under the label on the settings row. */
    description: string;
    level: NotificationLevel;
    /** Always reaches the bell, whatever the rule says. */
    critical?: boolean;
    /** Where the rule starts before anyone changes it. */
    defaults: { inapp: boolean; email: boolean };
}

export const NOTIFICATION_EVENTS: readonly NotificationEventInfo[] = [
    {
        id: "deploy.failed",
        group: "deploy",
        label: "Deploy failed",
        description: "A build or deploy of a service or database did not come up.",
        level: "danger",
        defaults: { inapp: true, email: true }
    },
    {
        id: "deploy.succeeded",
        group: "deploy",
        label: "Deploy succeeded",
        description: "A service or database finished deploying and is serving.",
        level: "success",
        defaults: { inapp: false, email: false }
    },
    {
        id: "domain.down",
        group: "deploy",
        label: "A domain stopped serving",
        description: "A domain pointed at one of your services stopped answering.",
        level: "danger",
        // Mail on by default, and deliberately so: this one is noticed by whoever is
        // looking at the site, and the owner is usually not.
        defaults: { inapp: true, email: true }
    },
    {
        id: "domain.up",
        group: "deploy",
        label: "A domain started serving again",
        description: "A domain that had stopped answering is reachable again.",
        level: "success",
        defaults: { inapp: true, email: false }
    },
    {
        id: "tasks.assigned",
        group: "tasks",
        label: "Assigned a task",
        description: "Somebody put a task in your name, or a rule did.",
        level: "info",
        defaults: { inapp: true, email: false }
    },
    {
        id: "tasks.shared",
        group: "tasks",
        label: "A task sent to you",
        description: "Somebody sent you a task to look at.",
        level: "info",
        // Mail is on by default here alone among the task events: a person chose
        // to send this to you, so it should reach you off the app as well.
        defaults: { inapp: true, email: true }
    },
    {
        id: "tasks.comment",
        group: "tasks",
        label: "Comment on your work",
        description: "A comment on a task you are assigned to or watching.",
        level: "info",
        defaults: { inapp: true, email: false }
    },
    {
        id: "tasks.mentioned",
        group: "tasks",
        label: "Mentioned by name",
        description: "Somebody wrote your name into a task, a comment or a page.",
        level: "info",
        // Being named is a direct address rather than activity on something you
        // follow, so it reaches you off the app the way a shared task does.
        defaults: { inapp: true, email: true }
    },
    {
        id: "tasks.due",
        group: "tasks",
        label: "Task reminder",
        description: "A reminder you set on a task, and work falling due today.",
        level: "warning",
        defaults: { inapp: true, email: false }
    },
    {
        id: "watch.alarm",
        group: "watch",
        label: "Alarm fired",
        description: "A watched service, domain or resource breached its condition.",
        level: "danger",
        defaults: { inapp: true, email: true }
    },
    {
        id: "watch.ok",
        group: "watch",
        label: "Alarm cleared",
        description: "A watched target came back within its condition.",
        level: "success",
        defaults: { inapp: true, email: false }
    },
    {
        id: "account.signin",
        group: "security",
        label: "Sign-in waiting for approval",
        description: "Someone signed in to your account and needs approving.",
        level: "warning",
        critical: true,
        defaults: { inapp: true, email: true }
    },
    {
        id: "account.recovery",
        group: "security",
        label: "Someone locked out of their account",
        description: "A request to reset a password is waiting for a decision.",
        level: "warning",
        critical: true,
        defaults: { inapp: true, email: true }
    },
    {
        id: "account.session.opened",
        group: "security",
        label: "A session was opened",
        description: "Your account was signed in to, and from where.",
        level: "info",
        // The bell rather than mail: on an account used daily this fires every
        // morning, and an alert that arrives that often stops being read.
        defaults: { inapp: true, email: false }
    },
    {
        id: "account.session.closed",
        group: "security",
        label: "A session ended",
        description: "A device was signed out, by you or by something else.",
        level: "info",
        defaults: { inapp: true, email: false }
    },
    {
        id: "account.friend",
        group: "people",
        // One entry for both halves of the same exchange: being asked, and
        // being answered. Somebody who wants to know about one wants to know
        // about the other, and two switches for one thing is two switches to
        // get wrong.
        label: "Friend requests",
        description: "Somebody asked to be added, or answered a request you sent.",
        level: "info",
        defaults: { inapp: true, email: false }
    },
    {
        id: "account.orgInvite",
        group: "people",
        // Both halves again, and for the same reason: whoever sent it wants to
        // know it was accepted as much as the person asked wants to know it is
        // there.
        label: "Organization invitations",
        description: "You were invited to an organization, or somebody accepted yours.",
        level: "info",
        // Mail as well, unlike a friend request: nothing happens until this one
        // is answered, and an invitation that expires unseen in a bell nobody
        // opened is an invitation that was never sent.
        defaults: { inapp: true, email: true }
    },
    {
        id: "account.security",
        group: "security",
        label: "Account security changed",
        description: "A password, a second factor, a passkey, a key or a sign-in rule changed.",
        level: "warning",
        // Critical, and mailed by default: this is the alert that tells somebody
        // their account is being taken over, and it is the first thing whoever
        // took it would otherwise turn off.
        critical: true,
        defaults: { inapp: true, email: true }
    },
    {
        id: "account.connection.expired",
        group: "security",
        label: "A connected account stopped working",
        description: "A token you linked ran out or was withdrawn, and what it was doing has stopped.",
        level: "danger",
        // Mailed by default, and for the same reason the key expiry is: nobody
        // watches the bell for a thing that has not happened yet, and the first
        // sign otherwise is a deploy failing at the clone for a reason that
        // reads like anything but an expired token.
        defaults: { inapp: true, email: true }
    },
    {
        id: "account.aiKey.expiring",
        group: "security",
        label: "An AI provider key is about to expire",
        description: "A key you gave an end date runs out within the week.",
        level: "warning",
        // Mail on by default: the whole point of setting the date is being told
        // before the day it stops working, and nobody watches the bell for that.
        defaults: { inapp: true, email: true }
    },
    {
        id: "account.aiKey.expired",
        group: "security",
        label: "An AI provider key expired",
        description: "A key reached its end date and is no longer used by anything.",
        level: "danger",
        defaults: { inapp: true, email: true }
    },
    {
        id: "drive.dropPoint.received",
        group: "drive",
        label: "Something arrived at a drop point",
        description: "A file or a piece of text was sent to one of your drop points.",
        level: "info",
        defaults: { inapp: true, email: false }
    },
    {
        id: "scan.detection",
        group: "drive",
        label: "Malware in an upload",
        description: "A file sent to one of your drop points was flagged.",
        level: "danger",
        critical: true,
        defaults: { inapp: true, email: true }
    },
    {
        id: "scan.error",
        group: "drive",
        label: "Upload could not be scanned",
        description: "The scanner did not finish. The file was kept.",
        level: "info",
        defaults: { inapp: true, email: false }
    },
    {
        id: "places.sighting",
        group: "places",
        label: "A camera saw something",
        description: "Somebody, a vehicle, an animal or a parcel came into view of a camera.",
        level: "info",
        // Off, and deliberately. A camera pointed at a room somebody works in
        // sees them all day, and every one of those is already written down in
        // Places. An alert is how you ask to be told about the few that matter,
        // so the bell is not the place to repeat the whole log.
        defaults: { inapp: false, email: false }
    },
    {
        id: "places.alert",
        group: "places",
        label: "An alert you wrote went off",
        description: "Something one of your alerts asked about happened.",
        level: "warning",
        defaults: { inapp: true, email: false }
    },
    {
        id: "places.tamper",
        group: "places",
        label: "A camera was interfered with",
        description: "A camera reported being covered, moved or unplugged.",
        level: "warning",
        defaults: { inapp: true, email: false }
    },
    {
        id: "network.router",
        group: "network",
        label: "Network needs attention",
        description: "Something outside Polaris is stopping your services being reached.",
        level: "warning",
        defaults: { inapp: true, email: false }
    },
    {
        id: "network.address",
        group: "network",
        label: "An address stopped answering",
        description: "One of the addresses this Polaris is reachable at went down, or came back.",
        level: "warning",
        defaults: { inapp: true, email: false }
    },
    {
        id: "integration.attention",
        group: "system",
        label: "An integration needs attention",
        description: "A service somebody tried to connect an account of refused the authorization.",
        level: "warning",
        // Mail on by default: the person who hit this cannot fix it and the
        // operator is not watching the bell of a service nobody could connect.
        defaults: { inapp: true, email: true }
    },
    {
        id: "system.update",
        group: "system",
        label: "Update available",
        description: "A new Polaris build is published and ready to install.",
        level: "info",
        defaults: { inapp: true, email: true }
    },
    {
        id: "system.updated",
        group: "system",
        label: "Update installed on its own",
        description: "A scheduled or automatic update ran, and how it went.",
        level: "success",
        defaults: { inapp: true, email: true }
    }
] as const;

const EVENT_BY_ID = new Map(NOTIFICATION_EVENTS.map((event) => [event.id, event]));

/** The catalogue entry for an event id, or null when nothing declares it. */
export function notificationEvent(id: string): NotificationEventInfo | null {
    return EVENT_BY_ID.get(id) ?? null;
}

export function isNotificationEvent(id: string): boolean {
    return EVENT_BY_ID.has(id);
}

/** Where one event goes. Destination ids point at the account's own rows. */
export const notificationRuleSchema = z.object({
    inapp: z.boolean(),
    email: z.boolean(),
    destinations: z.array(z.string().uuid()).max(20)
});

export type NotificationRule = z.infer<typeof notificationRuleSchema>;

/** Every rule an account has set, keyed by event id. Events left out follow
 *  their catalogue default, so a new event starts sensible without a migration. */
export const notificationPreferencesSchema = z.record(
    z.string().refine(isNotificationEvent, "Unknown event"),
    notificationRuleSchema
);

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** The rule an event starts with. */
export function defaultRule(event: NotificationEventInfo): NotificationRule {
    return { inapp: event.defaults.inapp, email: event.defaults.email, destinations: [] };
}

/**
 * The rule in force for one event: what the account saved, else the catalogue
 * default. A critical event always keeps the bell, so muting one can silence
 * mail and webhooks but never the record itself.
 */
export function resolveRule(
    preferences: NotificationPreferences,
    eventId: string
): NotificationRule {
    const event = EVENT_BY_ID.get(eventId);
    if (!event) return { inapp: true, email: false, destinations: [] };
    const saved = preferences[eventId];
    const rule = saved ? { ...saved, destinations: [...saved.destinations] } : defaultRule(event);
    if (event.critical) rule.inapp = true;
    return rule;
}

/** Whether a rule sends anywhere at all, for the "Muted" badge. */
export function isMuted(rule: NotificationRule): boolean {
    return !rule.inapp && !rule.email && rule.destinations.length === 0;
}

/** Parse the stored JSON blob, tolerating anything that is no longer valid -
 *  a rule naming a deleted event just stops applying. */
export function parseNotificationPreferences(
    raw: string | null | undefined
): NotificationPreferences {
    if (!raw) return {};
    try {
        const parsed = notificationPreferencesSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

export function stringifyNotificationPreferences(preferences: NotificationPreferences): string {
    return JSON.stringify(preferences);
}

/** A webhook endpoint as the add form submits it. */
export const webhookDestinationSchema = z.object({
    label: z.string().trim().min(1).max(60),
    url: z
        .string()
        .trim()
        .url("Enter the full URL the platform gave you")
        .max(2048)
        .refine((value) => value.startsWith("https://"), "The URL has to be https"),
    format: z.enum([...WEBHOOK_FORMATS, "auto"]).default("auto")
});

/** An SMS recipient. Stored in E.164 so a provider never has to guess a country. */
export const smsDestinationSchema = z.object({
    label: z.string().trim().min(1).max(60),
    phone: z
        .string()
        .trim()
        .regex(/^\+[1-9]\d{6,14}$/, "Enter the number in international form, like +34600111222")
});

export const destinationInputSchema = z.discriminatedUnion("kind", [
    webhookDestinationSchema.extend({ kind: z.literal("webhook") }),
    smsDestinationSchema.extend({ kind: z.literal("sms") })
]);

export type DestinationInput = z.infer<typeof destinationInputSchema>;

/**
 * The body shape a webhook URL wants, guessed from its host. Only Discord and
 * Slack are guessable; everything else gets the raw event, which is the only
 * safe assumption about somebody else's endpoint.
 */
export function detectWebhookFormat(url: string): WebhookFormat {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return "generic";
    }
    if (host === "discord.com" || host.endsWith(".discord.com") || host.endsWith("discordapp.com"))
        return "discord";
    if (host === "slack.com" || host.endsWith(".slack.com")) return "slack";
    return "generic";
}

/**
 * What is shown in place of a webhook URL. The URL is the credential - anyone
 * holding it can post as you - so only its host and a stub of the path are ever
 * rendered back.
 */
export function maskWebhookUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const tail = parsed.pathname
            .replace(/\/+$/, "")
            .split("/")
            .filter(Boolean)
            .slice(0, 2)
            .join("/");
        return tail ? `${parsed.host}/${tail}/...` : parsed.host;
    } catch {
        return "webhook";
    }
}

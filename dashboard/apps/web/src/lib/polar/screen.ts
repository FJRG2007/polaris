/**
 * Where the person is when they ask Polar something: the app, the section of
 * its rail, and the record the address opens. A pointer, never the content -
 * thirty to eighty tokens a question, and `read_current_view` reads the record
 * itself, with the person's own access, only when the model needs it.
 *
 * The app and section come from the navigation (`APP_SECTIONS`), so a screen
 * added to a rail is described the day it lands. The record comes from the
 * address, through the table below: every screen with an id in its route says
 * what kind of thing that id is, and a test fails for a route that does not.
 * A screen that knows the record's name (or a selection) adds it with
 * `usePolarContext`.
 *
 * Client-safe.
 */

import { APP_SECTIONS } from "@/lib/apps";

/** One screen whose address names a record: the route as the file tree spells
 *  it, the kind of record, and the segment that holds its id. A null kind is a
 *  screen whose dynamic part is a view or a tab, not a record. */
export interface ScreenRecord {
    readonly route: string;
    readonly kind: string | null;
    readonly id?: string;
}

/**
 * Every dynamic screen, signed-in side. Ordered most specific first, since the
 * first match wins. Routes of the installable apps are here too: the bundle
 * mounts them under the same paths.
 */
export const SCREEN_RECORDS: readonly ScreenRecord[] = [
    { route: "/o/[slug]", kind: "organization profile", id: "slug" },
    { route: "/u/[username]", kind: "user profile", id: "username" },
    { route: "/account/api-keys/[keyId]/usage", kind: "api key", id: "keyId" },
    { route: "/account/api-keys/[keyId]", kind: "api key", id: "keyId" },
    { route: "/account/organizations/[slug]/[[...section]]", kind: "organization", id: "slug" },
    { route: "/admin/apps/[appId]", kind: "marketplace app", id: "appId" },
    { route: "/admin/users/[id]", kind: "user", id: "id" },
    { route: "/announcements/[id]", kind: "announcement", id: "id" },
    { route: "/apps/agents/sessions/[sessionId]", kind: "agent session", id: "sessionId" },
    { route: "/apps/backups/[resourceId]", kind: "backup resource", id: "resourceId" },
    { route: "/apps/code/[owner]/[repo]/[number]", kind: "pull request", id: "number" },
    { route: "/apps/containers/[containerId]", kind: "container", id: "containerId" },
    { route: "/apps/deploy/[projectId]/[[...section]]", kind: "deploy project", id: "projectId" },
    { route: "/apps/games/[[...path]]", kind: null },
    { route: "/apps/installed/[id]/[[...tab]]", kind: "installed app", id: "id" },
    { route: "/apps/mail-server/[id]", kind: "mail server domain", id: "id" },
    { route: "/apps/marketplace/[appId]", kind: "marketplace app", id: "appId" },
    { route: "/apps/servers/cloud/[[...path]]", kind: null },
    { route: "/apps/servers/security/[[...path]]", kind: null },
    { route: "/apps/servers/ups/[upsId]", kind: "ups", id: "upsId" },
    { route: "/apps/servers/[serverId]", kind: "server", id: "serverId" },
    { route: "/automations/runs/[runId]", kind: "automation run", id: "runId" },
    { route: "/automations/[id]", kind: "automation", id: "id" },
    { route: "/calendar/booking/[id]", kind: "booking page", id: "id" },
    { route: "/calendar/proposals/[id]", kind: "meeting poll", id: "id" },
    { route: "/calendar/[[...path]]", kind: null },
    { route: "/chat/c/[channelId]/settings/[[...section]]", kind: "chat channel", id: "channelId" },
    { route: "/chat/c/[channelId]/[messageId]", kind: "chat message", id: "messageId" },
    { route: "/chat/c/[channelId]/[[...section]]", kind: "chat channel", id: "channelId" },
    { route: "/chat/i/[code]", kind: null },
    { route: "/chat/meetings/[meetingId]", kind: "meeting", id: "meetingId" },
    { route: "/chat/play/[sessionId]", kind: "game lobby", id: "sessionId" },
    { route: "/chat/s/[spaceId]/[[...section]]", kind: "chat space", id: "spaceId" },
    { route: "/chat/with/[userId]", kind: "direct conversation", id: "userId" },
    { route: "/crm/[[...path]]", kind: null },
    { route: "/drive/drop-points/text/[id]", kind: "text request", id: "id" },
    { route: "/drive/drop-points/[id]", kind: "drop point", id: "id" },
    { route: "/drive/snippets/[id]", kind: "snippet", id: "id" },
    { route: "/games/[[...path]]", kind: null },
    { route: "/mail/a/[accountId]", kind: "mail account", id: "accountId" },
    { route: "/mail/shared/[accountId]", kind: "shared mailbox", id: "accountId" },
    { route: "/mail/f/[folderId]", kind: "mail folder", id: "folderId" },
    { route: "/mail/label/[labelId]", kind: "mail label", id: "labelId" },
    { route: "/mail/t/[threadId]", kind: "mail conversation", id: "threadId" },
    { route: "/mail/[view]", kind: null },
    { route: "/office/c/[id]", kind: "office canvas", id: "id" },
    { route: "/office/d/[id]", kind: "office document", id: "id" },
    { route: "/office/g/[id]", kind: "office diagram", id: "id" },
    { route: "/office/kind/[kind]", kind: null },
    { route: "/office/p/[id]", kind: "office presentation", id: "id" },
    { route: "/office/s/[id]", kind: "office sheet", id: "id" },
    { route: "/places/devices/automations/[id]", kind: "places automation", id: "id" },
    { route: "/places/[[...path]]", kind: null },
    { route: "/polar/shared/[id]", kind: "shared polar chat", id: "id" },
    { route: "/status-pages/[[...path]]", kind: null },
    { route: "/tasks/l/[listId]", kind: "task list", id: "listId" },
    { route: "/tasks/s/[spaceId]", kind: "task space", id: "spaceId" },
    { route: "/tasks/t/[taskId]", kind: "task", id: "taskId" },
    { route: "/wall/[id]", kind: "wall panel", id: "id" },
    { route: "/watch/[kind]/[id]", kind: "watched resource", id: "id" }
];

/** A route as the file tree spells it, as a pattern over real addresses, with
 *  the names of the segments it captures. */
function compile(route: string): { pattern: RegExp; names: string[] } {
    const names: string[] = [];
    let source = "";
    for (const segment of route.split("/").filter(Boolean)) {
        const rest = /^\[\[\.\.\.(\w+)\]\]$/.exec(segment);
        const one = /^\[(\w+)\]$/.exec(segment);
        if (rest) {
            names.push(rest[1]!);
            source += "(?:/(.*))?";
        } else if (one) {
            names.push(one[1]!);
            source += "/([^/]+)";
        } else {
            source += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
        }
    }
    return { pattern: new RegExp(`^${source || "/"}/?$`), names };
}

const COMPILED = SCREEN_RECORDS.map((entry) => ({ entry, ...compile(entry.route) }));

/** The screen record a route matches, or null. Exported for the test. */
export function screenRecordFor(pathname: string): ScreenRecord | null {
    return COMPILED.find(({ pattern }) => pattern.test(pathname))?.entry ?? null;
}

export interface ScreenDescriptor {
    app?: string;
    section?: string;
    record?: { kind: string; id: string; name?: string };
}

/** Every rail entry, longest address first, so `/drive/shared` beats `/drive`. */
const SECTIONS = Object.entries(APP_SECTIONS)
    .flatMap(([app, sections]) =>
        sections.map((section) => ({ app, label: section.label, href: section.href }))
    )
    .sort((a, b) => b.href.length - a.href.length);

/** The app, section and record an address shows. */
export function screenFor(pathname: string): ScreenDescriptor {
    const path = pathname.replace(/\/+$/, "") || "/";
    const section = SECTIONS.find(({ href }) => path === href || path.startsWith(`${href}/`));
    const app = section?.app ?? path.split("/").filter(Boolean)[0];
    const descriptor: ScreenDescriptor = {
        ...(app ? { app } : {}),
        ...(section ? { section: section.label } : {})
    };
    const found = COMPILED.find(({ pattern }) => pattern.test(path));
    if (!found?.entry.kind || !found.entry.id) return descriptor;
    const match = found.pattern.exec(path);
    const raw = match?.[found.names.indexOf(found.entry.id) + 1];
    if (!raw) return descriptor;
    let id: string;
    try {
        id = decodeURIComponent(raw);
    } catch {
        return descriptor;
    }
    return { ...descriptor, record: { kind: found.entry.kind, id } };
}

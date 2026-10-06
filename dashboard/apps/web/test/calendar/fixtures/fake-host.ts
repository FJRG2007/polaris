/**
 * A fake `@polaris/app-host` for the Calendar's server code: the services it
 * calls, answering from the fake database and recording what was sent - every
 * notification, every mail, every rate-limit key - for tests to assert on.
 */

import { db, type Row } from "./fake-db";

export interface FakeUser {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly isAdmin: boolean;
    readonly username: string | null;
    readonly sessionId: string;
}

export interface SentMail {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly calendar?: { readonly method: string; readonly ics: string };
}

export interface Notice {
    readonly userId: string;
    readonly event: string;
    readonly title: string;
    readonly body?: string | null;
    readonly href?: string;
}

/** The error the dashboard's guarded fetch throws for a private address. */
export class RefusedAddressError extends Error {
    public constructor() {
        super("That address cannot be reached from here.");
        this.name = "RefusedAddressError";
    }
}

/** Whether a URL points into a private network, the way the guarded fetch decides. */
function privateAddress(raw: string): boolean {
    const host = new URL(raw).hostname;
    return (
        host === "localhost" ||
        /^(10|127)\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
}

type Handler = (url: string, init: RequestInit) => Promise<Response>;

function blankState() {
    return {
        /** Who is signed in; null answers the session's redirect. */
        current: null as FakeUser | null,
        /** Permissions by user id; `calendar.use` is everybody's unless removed. */
        denied: new Map<string, Set<string>>(),
        granted: new Map<string, Set<string>>(),
        /** Team id -> member ids. */
        teams: new Map<string, string[]>(),
        locales: new Map<string, string>(),
        /** Account display zones by user id; "auto" when unset. */
        timeZones: new Map<string, string>(),
        requestLocale: "en-US",
        notices: [] as Notice[],
        mails: [] as SentMail[],
        mailError: null as string | null,
        rateKeys: [] as string[],
        rateAllowed: true,
        fetches: [] as { url: string; allowPrivate: boolean }[],
        fetchHandler: (async () => new Response("", { status: 404 })) as Handler,
        links: [] as {
            id: string;
            provider: "google" | "microsoft";
            label: string;
            grantsCalendar: boolean;
        }[],
        tasks: [] as {
            id: string;
            name: string;
            due: string | null;
            timed: boolean;
            done: boolean;
            reference: string;
            listName: string;
            statusType?: "open" | "active" | "blocked" | "done" | "closed";
            statusColor?: string;
            statusName?: string;
        }[],
        scheduled: [] as { taskId: string; due: unknown }[],
        /** Tasks-app tasks ticked or unticked from the calendar. */
        doneSet: [] as { taskId: string; done: boolean }[],
        /** Why ticking a Tasks-app task is turned down, when it is. */
        doneRefusal: null as string | null,
        /** Lists a task can be created in; null when Tasks is not theirs. */
        taskLists: [] as { id: string; name: string; spaceName: string }[] | null,
        createdTasks: [] as {
            actorId: string;
            listId: string;
            name: string;
            due: { at: string; timed: boolean };
        }[],
        /** Whether each provider's sign-in application is set up. */
        linkReady: { google: true, microsoft: true },
        /** The dashboard's key-value settings. */
        settings: new Map<string, string>()
    };
}

export const fake = blankState();

/** Put every recording and setting back as a new test expects them. */
export function resetHost(): void {
    Object.assign(fake, blankState());
}

/** A Polaris account, in the fake database and ready to sign in as. */
export function addUser(input: {
    name: string;
    email: string;
    isAdmin?: boolean;
    username?: string | null;
}): FakeUser {
    const row = db.insert("user", {
        name: input.name,
        email: input.email.toLowerCase(),
        isAdmin: input.isAdmin ?? false,
        username: input.username ?? null
    });
    return {
        id: row.id as string,
        name: input.name,
        email: input.email.toLowerCase(),
        isAdmin: input.isAdmin ?? false,
        username: input.username ?? null,
        sessionId: `session-${String(row.id)}`
    };
}

export function signIn(user: FakeUser | null): void {
    fake.current = user;
}

/** A team with these members. */
export function addTeam(name: string, members: readonly string[]): string {
    const row = db.insert("team", { name, orgName: "Example Org" });
    fake.teams.set(row.id as string, [...members]);
    return row.id as string;
}

function can(userId: string, permission: string): boolean {
    if (fake.denied.get(userId)?.has(permission)) return false;
    if (permission === "calendar.use") return true;
    return fake.granted.get(userId)?.has(permission) ?? false;
}

function person(row: Row) {
    return {
        id: row.id as string,
        name: row.name as string,
        email: row.email as string,
        username: (row.username as string | null) ?? null
    };
}

export const host = {
    session: {
        requirePermission: async (permission: string): Promise<FakeUser> => {
            const user = fake.current;
            if (!user || !can(user.id, permission))
                throw new Error("NEXT_REDIRECT;replace;/login;307;");
            return user;
        },
        sessionCan: async (user: { id: string }, permission: string): Promise<boolean> =>
            can(user.id, permission)
    },
    apiSession: {
        apiUser: async (): Promise<FakeUser | Response> =>
            fake.current ?? new Response(null, { status: 401 })
    },
    i18nRequest: { getLocale: async () => fake.requestLocale },
    i18nLocaleService: {
        getUserLocale: async (userId: string) => fake.locales.get(userId) ?? "en-US"
    },
    notificationsDispatch: {
        notify: async (notice: Notice): Promise<void> => {
            fake.notices.push(notice);
        }
    },
    rateLimitService: {
        rateLimit: async (key: string) => {
            fake.rateKeys.push(key);
            return { ok: fake.rateAllowed };
        }
    },
    requestContext: { clientIp: async () => "203.0.113.7" },
    settingStore: {
        getSetting: async (key: string) => fake.settings.get(key) ?? null,
        setSetting: async (key: string, value: string) => {
            fake.settings.set(key, value);
        }
    },
    domainService: { appBaseUrl: async () => "https://polaris.example.test" },
    calendarHost: {
        teamIdsOf: async (userId: string) =>
            [...fake.teams.entries()]
                .filter(([, members]) => members.includes(userId))
                .map(([id]) => id),
        teamMemberIds: async (teamId: string) => [...(fake.teams.get(teamId) ?? [])],
        displayTimeZone: async (userId: string) => fake.timeZones.get(userId) ?? "auto",
        teamsOf: async (userId: string) =>
            db
                .rows("team")
                .filter((team) => fake.teams.get(team.id as string)?.includes(userId))
                .map((team) => ({
                    id: team.id as string,
                    name: team.name as string,
                    orgName: team.orgName as string
                })),
        peopleByIds: async (ids: readonly string[]) =>
            db
                .rows("user")
                .filter((row) => ids.includes(row.id as string))
                .map(person),
        accountsByEmail: async (emails: readonly string[]) => {
            const wanted = new Set(emails.map((email) => email.trim().toLowerCase()));
            return [
                ...db
                    .rows("user")
                    .filter((row) => wanted.has(row.email as string))
                    .map((row) => ({ id: row.id as string, email: row.email as string })),
                ...db
                    .rows("userEmail")
                    .filter((row) => wanted.has(row.email as string) && row.verifiedAt !== null)
                    .map((row) => ({ id: row.userId as string, email: row.email as string }))
            ];
        },
        searchPeople: async (_actor: unknown, query: string) =>
            db
                .rows("user")
                .filter((row) => (row.name as string).toLowerCase().includes(query.toLowerCase()))
                .map(person),
        peopleInReach: async (_actor: unknown, ids: readonly string[]) =>
            db
                .rows("user")
                .filter((row) => ids.includes(row.id as string))
                .map((row) => row.id as string),
        sendCalendarEmail: async (message: SentMail): Promise<{ error?: string }> => {
            if (fake.mailError) return { error: fake.mailError };
            fake.mails.push(message);
            return {};
        },
        calendarFetch: async (
            url: string,
            init: RequestInit,
            options: { allowPrivate: boolean }
        ): Promise<Response> => {
            fake.fetches.push({ url, allowPrivate: options.allowPrivate });
            if (!options.allowPrivate && privateAddress(url)) throw new RefusedAddressError();
            return fake.fetchHandler(url, init);
        },
        calendarAccessToken: async () => "fake-access-token",
        openCalendarSecret: async (source: { encryptedSecret: Uint8Array | null }) =>
            source.encryptedSecret ? Buffer.from(source.encryptedSecret).toString("utf8") : null,
        sealCalendarSecret: async (secret: string) => ({
            encryptedSecret: new Uint8Array(Buffer.from(secret, "utf8")),
            secretNonce: new Uint8Array(12),
            secretKeyId: "fake-key"
        }),
        listCalendarLinks: async () => [...fake.links],
        calendarLinkUrl: async (provider: string) =>
            `/account/connections/new?provider=${provider}&scope=calendar`,
        calendarLinkAvailable: async (provider: "google" | "microsoft") => fake.linkReady[provider],
        googleClientProject: async () => null,
        taskListsFor: async () => (fake.taskLists ? [...fake.taskLists] : null),
        createDueTask: async (
            actor: { id: string },
            input: { listId: string; name: string; due: { at: string; timed: boolean } }
        ) => {
            if (!fake.taskLists?.some((list) => list.id === input.listId))
                return { refused: "That list no longer exists." };
            fake.createdTasks.push({ actorId: actor.id, ...input });
            return {
                id: `task-${fake.createdTasks.length}`,
                reference: `T-${fake.createdTasks.length}`
            };
        },
        assignedTasks: async () =>
            fake.tasks.map((task) => ({
                statusType: task.done ? "done" : "open",
                statusColor: "#64748b",
                statusName: task.done ? "Done" : "To do",
                ...task
            })),
        setTaskDone: async (_actor: unknown, taskId: string, done: boolean) => {
            if (fake.doneRefusal) return { refused: fake.doneRefusal };
            fake.doneSet.push({ taskId, done });
            return {};
        },
        scheduleTask: async (_actor: unknown, taskId: string, due: unknown) => {
            fake.scheduled.push({ taskId, due });
        },
        createMeetingLink: async () => "https://polaris.example.test/chat/meet/fake"
    }
};

/** What `vi.mock("@polaris/app-host", ...)` answers with. */
export const hostModule = { host };

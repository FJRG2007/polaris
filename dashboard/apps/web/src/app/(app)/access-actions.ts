"use server";

/**
 * Sharing one thing with somebody, from whichever screen it is being shared on.
 *
 * One set of actions rather than a set per app, because the four steps are the
 * same everywhere - who may share this, who is on offer, write it, take it back -
 * and the only part that differs is the first, which is dispatched in
 * `sharing-service.ts` to the app that owns the thing.
 *
 * Every one of these resolves the caller against the subject **before** touching
 * a grant, and the subject is named by the screen rather than by the row: a
 * request cannot hand over a grant id and have it looked up, because that would
 * be a way of editing a grant on something else.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { findPeople } from "@/lib/people-search";
import { recordAudit } from "@/lib/audit-service";
import { publishAccessChange } from "@/lib/access-live";
import {
    owningOrgIds,
    requireMayShare,
    shareCandidates,
    subjectHref,
    subjectOrg,
    subjectPlaceLocated,
    type GrantCandidate
} from "@/lib/access/sharing-service";
import { appBaseUrl, sharingBaseUrl } from "@/lib/domain-service";
import { translatorFor } from "@/lib/i18n/translate";
import { createNotification } from "@/lib/notification-service";
import {
    GrantError,
    listSubjectGrantPage,
    listSubjectGrants,
    removeGrant,
    setLinkAudience,
    updateGrant,
    writeGrant,
    writeGrantLink,
    type GrantPage,
    type GrantView
} from "@/lib/access/grants";

/** What a refusal reads as. Anything else is logged and replaced, the same rule
 *  the rest of the app follows: an internal message names paths nobody asked to
 *  publish. */
type ShareFailure =
    "share.unreadable" | "share.notWritten" | "share.nobodyFound" | "share.notTakenBack";

async function refusal(caught: unknown, key: ShareFailure): Promise<{ error: string }> {
    if (caught instanceof GrantError) return { error: caught.message };
    if (caught instanceof Error && caught.name.endsWith("AccessError")) {
        return { error: caught.message };
    }
    console.error("[access] share failed", caught);
    return { error: (await getTranslations("common"))(key) };
}

/** Read the subject off the wire. An unknown one is refused rather than guessed
 *  at: it decides which app is asked whether the caller may share. */
function subjectOf(value: unknown): core.GrantSubject {
    if (!core.isGrantSubject(value)) throw new GrantError("That cannot be shared");
    return value;
}

/**
 * Tell the person something was handed to, in the bell and in their own
 * language. A team or a role is not told one by one: who is in it is a query and
 * a chance to tell the wrong people. Best-effort, like every notice.
 */
async function tellGrantee(
    sharer: { id: string; name?: string | null },
    subject: core.GrantSubject,
    subjectId: string,
    userId: string,
    /** What the sharer wrote to go with it, shown under the notice. */
    message = ""
): Promise<void> {
    if (userId === sharer.id) return;
    let words = translatorFor(core.DEFAULT_LOCALE, "common");
    try {
        const { getUserLocale } = await import("@/lib/i18n/locale-service");
        words = translatorFor(await getUserLocale(userId), "common");
    } catch {
        // The default language, then.
    }
    await createNotification({
        userId,
        type: "access.shared",
        title: words("share.notice", {
            name: sharer.name || words("share.somebody"),
            what: words(`share.subjects.${subject}`)
        }),
        body: message || null,
        href: subjectHref(subject, subjectId),
        level: "info"
    });
}

/**
 * Redraw the screens a share changes, where the server draws them.
 *
 * Only Places: its lists are rendered per request and a lent door has to appear
 * for the person it was lent to. Chat and Tasks resolve access on the way into
 * every screen and already redraw themselves on the caller's own next move.
 */
function settled(subject: core.GrantSubject): void {
    if (subject.startsWith("place.")) revalidatePath("/places");
}

export async function listGrantsAction(
    subject: string,
    subjectId: string
): Promise<{
    grants?: GrantView[];
    candidates?: GrantCandidate[];
    located?: boolean | null;
    error?: string;
}> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        const [grants, candidates, located] = await Promise.all([
            listSubjectGrants(kind, String(subjectId)),
            shareCandidates(user, kind, String(subjectId)),
            subjectPlaceLocated(kind, String(subjectId))
        ]);
        return { grants, candidates, located };
    } catch (caught) {
        return refusal(caught, "share.unreadable");
    }
}

export async function shareAction(
    subject: string,
    subjectId: string,
    input: unknown
): Promise<{ grants?: GrantView[]; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        const parsed = core.accessGrantSchema.safeParse(input);
        if (!parsed.success) {
            return {
                error:
                    parsed.error.issues[0]?.message ??
                    (await getTranslations("common"))("share.notWritten")
            };
        }
        // The same scoping the picker was filled from, asked again here: what a
        // form offered is not what a call has to carry.
        await writeGrant(
            kind,
            String(subjectId),
            parsed.data,
            user.id,
            await owningOrgIds(user, kind, String(subjectId))
        );
        await recordAudit({
            actorId: user.id,
            action: "access.shared",
            targetType: kind,
            targetId: String(subjectId),
            metadata: {
                principalType: parsed.data.principalType,
                capability: parsed.data.capability,
                // Never the note: it is free text somebody wrote about a person.
                bounded: Boolean(
                    parsed.data.endsAt || parsed.data.startMinute || parsed.data.maxUses
                )
            }
        });
        settled(kind);
        if (parsed.data.principalType === "user") {
            await tellGrantee(user, kind, String(subjectId), parsed.data.principalId);
        }
        // Lending somebody a thing can hand them a whole app: a door opens
        // Places for a visitor who holds none of its permissions, a game server
        // opens Game servers. Their switcher is drawn on the server, so without
        // this they are given something they cannot see until they reload. A
        // team or a role is everybody in it, which is a query and a chance to be
        // wrong - so only a person is named. See `access-live`.
        publishAccessChange(
            parsed.data.principalType === "user" ? { userIds: [parsed.data.principalId] } : {}
        );
        return { grants: await listSubjectGrants(kind, String(subjectId)) };
    } catch (caught) {
        return refusal(caught, "share.notWritten");
    }
}

/**
 * Hand something in Places out as a link, for somebody with no account.
 *
 * The same standing as sharing it with a person, the same bounds, and the link
 * comes back once - only its hash is kept, so it cannot be shown again, only
 * taken back and made anew. Built on the sharing domain, never the tab's host:
 * the person it is sent to is not on this network.
 */
export async function shareLinkAction(
    subject: string,
    subjectId: string,
    input: unknown
): Promise<{ grants?: GrantView[]; link?: string; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        if (!core.isGrantLinkSubject(kind)) {
            throw new GrantError("That cannot be shared as a link");
        }
        await requireMayShare(user, kind, String(subjectId));
        const parsed = core.grantLinkSchema.safeParse(input);
        if (!parsed.success) {
            return {
                error:
                    parsed.error.issues[0]?.message ??
                    (await getTranslations("common"))("share.notWritten")
            };
        }
        const org =
            parsed.data.audience === "org" ? await subjectOrg(kind, String(subjectId)) : null;
        const { token } = await writeGrantLink(
            kind,
            String(subjectId),
            parsed.data,
            user.id,
            org?.id ?? null
        );
        await recordAudit({
            actorId: user.id,
            action: "access.linked",
            targetType: kind,
            targetId: String(subjectId),
            metadata: {
                capability: parsed.data.capability,
                actions: parsed.data.actions,
                audience: parsed.data.audience,
                nearby: parsed.data.nearbyMeters !== null,
                bounded: Boolean(
                    parsed.data.endsAt || parsed.data.startMinute || parsed.data.maxUses
                )
            }
        });
        settled(kind);
        const base = (await sharingBaseUrl()).replace(/\/+$/, "");
        return {
            grants: await listSubjectGrants(kind, String(subjectId)),
            link: `${base}/k/${token}`
        };
    } catch (caught) {
        return refusal(caught, "share.notWritten");
    }
}

/**
 * People this thing can be handed to, by name.
 *
 * Searched rather than listed, and through the same rules every other people
 * search here obeys: nothing at all under two characters, and anybody who has
 * hidden themselves is not found. Sharing a door does not entitle the sharer to
 * a directory of the instance.
 */
export async function findSharePeopleAction(
    subject: string,
    subjectId: string,
    query: string
): Promise<{ people?: { id: string; name: string }[]; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        // `reachableOnly` is false: the question is who exists, not who holds the
        // app - somebody lent a door reaches Places because of the grant itself.
        const found = await findPeople({ id: user.id }, String(query), { reachableOnly: false });
        return { people: found.people };
    } catch (caught) {
        return refusal(caught, "share.nobodyFound");
    }
}

export async function revokeShareAction(
    subject: string,
    subjectId: string,
    grantId: string
): Promise<{ grants?: GrantView[]; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        await removeGrant(kind, String(subjectId), String(grantId));
        await recordAudit({
            actorId: user.id,
            action: "access.revoked",
            targetType: kind,
            targetId: String(subjectId)
        });
        settled(kind);
        // Nobody is named: what the grant said is gone by now, and the person
        // who has just lost the app is the one who most needs the screen to
        // stop offering it.
        publishAccessChange();
        return { grants: await listSubjectGrants(kind, String(subjectId)) };
    } catch (caught) {
        return refusal(caught, "share.notTakenBack");
    }
}

/** What the dialog needs once, beside the first page: who is asking, what they
 *  may hand out to, and the address Copy link copies. */
export interface ShareSetup {
    readonly viewer: { id: string; name: string; email: string };
    readonly candidates: GrantCandidate[];
    readonly located: boolean | null;
    /** The organization an "organization" link would open for, if any. */
    readonly org: { id: string; name: string } | null;
    /** The thing's own address on the Polaris domain, for people with access. */
    readonly url: string | null;
}

export async function shareSetupAction(
    subject: string,
    subjectId: string
): Promise<{ setup?: ShareSetup; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        const [candidates, located, org, base] = await Promise.all([
            shareCandidates(user, kind, String(subjectId)),
            subjectPlaceLocated(kind, String(subjectId)),
            subjectOrg(kind, String(subjectId)),
            appBaseUrl()
        ]);
        const href = subjectHref(kind, String(subjectId));
        return {
            setup: {
                viewer: { id: user.id, name: user.name, email: user.email },
                candidates,
                located,
                org,
                url: href ? `${base.replace(/\/+$/, "")}${href}` : null
            }
        };
    } catch (caught) {
        return refusal(caught, "share.unreadable");
    }
}

/**
 * One page of who has this, or of its links, with the total. Paged and searched
 * on the server: a thing shared with thousands is never sent whole.
 */
export async function grantPageAction(
    subject: string,
    subjectId: string,
    query: { links?: unknown; search?: unknown; cursor?: unknown }
): Promise<{ page?: GrantPage; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        const search = typeof query.search === "string" ? query.search.slice(0, 100) : "";
        const cursor =
            typeof query.cursor === "string" && /^[0-9a-f-]{36}$/i.test(query.cursor)
                ? query.cursor
                : null;
        const page = await listSubjectGrantPage(
            kind,
            String(subjectId),
            { links: query.links === true, search, cursor },
            { id: user.id }
        );
        return { page };
    } catch (caught) {
        return refusal(caught, "share.unreadable");
    }
}

/** One thing the "Add people" box found: a person, a team or a role. */
export interface ShareTarget {
    readonly type: core.GrantPrincipal;
    readonly id: string;
    readonly name: string;
    /** The organization, a member count or a role's description. */
    readonly detail: string;
}

/** How many of each kind the box shows at once. */
const TARGETS_PER_KIND = 8;

/**
 * Everything this may be handed to whose name matches, in one ranked list:
 * people through the same search every other people picker uses, and the
 * owning organization's teams and roles. A name that starts with what was
 * typed comes before one that only contains it. Bounded per kind.
 */
export async function findShareTargetsAction(
    subject: string,
    subjectId: string,
    query: string
): Promise<{ targets?: ShareTarget[]; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        const term = String(query).trim().slice(0, 100);
        if (term.length < 2) return { targets: [] };
        const allowed = core.subjectPrincipals(kind);
        const [found, groups] = await Promise.all([
            allowed.includes("user")
                ? findPeople({ id: user.id }, term, {
                      reachableOnly: false,
                      limit: TARGETS_PER_KIND
                  })
                : Promise.resolve({ people: [] as { id: string; name: string }[] }),
            allowed.includes("team") || allowed.includes("role")
                ? shareCandidates(user, kind, String(subjectId))
                : Promise.resolve([] as GrantCandidate[])
        ]);
        const lower = term.toLowerCase();
        const matching = (name: string) => name.toLowerCase().includes(lower);
        const rank = (name: string) => (name.toLowerCase().startsWith(lower) ? 0 : 1);
        const targets: ShareTarget[] = [
            ...found.people.map((person) => ({
                type: "user" as const,
                id: person.id,
                name: person.name,
                detail: ""
            })),
            ...(["team", "role"] as const).flatMap((type) =>
                allowed.includes(type)
                    ? groups
                          .filter((one) => one.type === type && matching(one.name))
                          .slice(0, TARGETS_PER_KIND)
                          .map((one) => ({
                              type,
                              id: one.id,
                              name: one.name,
                              detail: one.orgName
                          }))
                    : []
            )
        ];
        return {
            targets: targets
                .map((target, index) => ({ target, index }))
                .sort((a, b) => rank(a.target.name) - rank(b.target.name) || a.index - b.index)
                .map((one) => one.target)
        };
    } catch (caught) {
        return refusal(caught, "share.nobodyFound");
    }
}

/** The most people and groups one press of Share may add. */
const MAX_TARGETS_PER_SHARE = 20;

/**
 * Hand this to several people and groups at once, with the same capability and
 * bounds, and - when asked - a notice in each person's bell carrying the
 * message. Each one is written through the same checks as `shareAction`.
 */
export async function shareManyAction(
    subject: string,
    subjectId: string,
    input: { targets?: unknown; grant?: unknown; notify?: unknown; message?: unknown }
): Promise<{ added?: number; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        const targets = Array.isArray(input.targets)
            ? input.targets.slice(0, MAX_TARGETS_PER_SHARE)
            : [];
        if (targets.length === 0) {
            return { error: (await getTranslations("common"))("share.notWritten") };
        }
        const message =
            typeof input.message === "string" ? input.message.trim().slice(0, 500) : "";
        const orgIds = await owningOrgIds(user, kind, String(subjectId));
        const written: core.AccessGrantInput[] = [];
        for (const target of targets) {
            const parsed = core.accessGrantSchema.safeParse({
                ...(typeof input.grant === "object" && input.grant ? input.grant : {}),
                ...(typeof target === "object" && target ? target : {})
            });
            if (!parsed.success) {
                return {
                    error:
                        parsed.error.issues[0]?.message ??
                        (await getTranslations("common"))("share.notWritten")
                };
            }
            await writeGrant(kind, String(subjectId), parsed.data, user.id, orgIds);
            written.push(parsed.data);
        }
        await recordAudit({
            actorId: user.id,
            action: "access.shared",
            targetType: kind,
            targetId: String(subjectId),
            metadata: { count: written.length, capability: written[0]?.capability }
        });
        settled(kind);
        const people = written
            .filter((one) => one.principalType === "user")
            .map((one) => one.principalId);
        if (input.notify !== false) {
            for (const id of people) {
                await tellGrantee(user, kind, String(subjectId), id, message);
            }
        }
        publishAccessChange(people.length > 0 ? { userIds: people } : {});
        return { added: written.length };
    } catch (caught) {
        return refusal(caught, "share.notWritten");
    }
}

/** Change one grant's capability, actions or bounds - the role dropdown and the
 *  Limits editor on a row of "People with access". */
export async function updateShareAction(
    subject: string,
    subjectId: string,
    grantId: string,
    input: unknown
): Promise<{ ok?: true; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        const parsed = core.grantUpdateSchema.safeParse(input);
        if (!parsed.success) {
            return {
                error:
                    parsed.error.issues[0]?.message ??
                    (await getTranslations("common"))("share.notWritten")
            };
        }
        await updateGrant(kind, String(subjectId), String(grantId), parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "access.changed",
            targetType: kind,
            targetId: String(subjectId),
            metadata: { capability: parsed.data.capability }
        });
        settled(kind);
        publishAccessChange();
        return { ok: true };
    } catch (caught) {
        return refusal(caught, "share.notWritten");
    }
}

/** Who one link opens for: restricted, the organization, or anyone. */
export async function setLinkAudienceAction(
    subject: string,
    subjectId: string,
    grantId: string,
    audience: string
): Promise<{ ok?: true; error?: string }> {
    try {
        const user = await requireUser();
        const kind = subjectOf(subject);
        await requireMayShare(user, kind, String(subjectId));
        if (!core.isLinkAudience(audience)) throw new GrantError("That cannot be shared");
        const org = audience === "org" ? await subjectOrg(kind, String(subjectId)) : null;
        await setLinkAudience(kind, String(subjectId), String(grantId), audience, org?.id ?? null);
        await recordAudit({
            actorId: user.id,
            action: "access.linkAudience",
            targetType: kind,
            targetId: String(subjectId),
            metadata: { audience }
        });
        settled(kind);
        return { ok: true };
    } catch (caught) {
        return refusal(caught, "share.notWritten");
    }
}

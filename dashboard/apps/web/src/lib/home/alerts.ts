/**
 * Telling somebody, in the place they will actually see it.
 *
 * The bell is a record - a list you come back to and clear - and that is right
 * for "an update is available" and wrong for somebody at the door at three in
 * the morning. That is worth interrupting for, once, and then it is over. So an
 * alert is delivered as a message in a conversation: it arrives the way a
 * message arrives, it can be muted the way a conversation is muted, and it
 * leaves a thread to scroll rather than a badge to clear.
 *
 * The conversation is made the first time a rule fires, not when it is written.
 * A rule nobody ever triggers should not leave a room in everybody's sidebar.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "@/lib/home/home-error";

import { withinHours } from "@/lib/home/detection";
import type { Detection } from "@/lib/home/events";
import { publishChatChange } from "@/lib/chat/live";

export interface AlertRuleView {
    readonly id: string;
    readonly name: string;
    readonly placeId: string | null;
    readonly cameraId: string | null;
    readonly kinds: readonly string[];
    readonly label: string | null;
    /** Only what was standing in one of these areas, by name. Empty is
     *  anywhere the camera can see, which is what every rule written before
     *  areas existed means and what most rules mean anyway. */
    readonly zones: readonly string[];
    readonly hours: { from: number; to: number } | null;
    readonly recipients: readonly string[];
    readonly enabled: boolean;
    /** The conversation it posts into, once it has fired at least once. */
    readonly channelId: string | null;
}

export interface AlertRuleInput {
    readonly name: string;
    readonly placeId: string | null;
    readonly cameraId: string | null;
    readonly kinds: readonly string[];
    readonly label: string | null;
    readonly zones: readonly string[];
    readonly hours: { from: number; to: number } | null;
    readonly recipients: readonly string[];
    readonly enabled: boolean;
}

/** A stored JSON column, or the fallback. A malformed one means the rule falls
 *  back to its default rather than taking a screen down. */
function parseJson<T>(raw: string | null, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

type Row = Awaited<ReturnType<typeof prisma.alertRule.findFirst>>;

function toView(row: NonNullable<Row>): AlertRuleView {
    return {
        id: row.id,
        name: row.name,
        placeId: row.placeId,
        cameraId: row.cameraId,
        kinds: parseJson<string[]>(row.kinds, ["person"]),
        label: row.label,
        zones: parseJson<string[]>(row.zones, []),
        hours: parseJson<{ from: number; to: number } | null>(row.hours, null),
        recipients: parseJson<string[]>(row.recipients, []),
        enabled: row.enabled,
        channelId: row.channelId
    };
}

export async function listAlertRules(
    installedAppId: string,
    placeId?: string | null
): Promise<AlertRuleView[]> {
    const rows = await prisma.alertRule.findMany({
        where: { installedAppId, ...(placeId ? { OR: [{ placeId }, { placeId: null }] } : {}) },
        orderBy: { createdAt: "asc" }
    });
    return rows.map(toView);
}

export async function saveAlertRule(
    installedAppId: string,
    id: string | null,
    actorId: string,
    input: AlertRuleInput
): Promise<AlertRuleView> {
    const name = input.name.trim();
    if (!name) throw new HomeError("Give it a name");
    if (input.kinds.length === 0) throw new HomeError("Choose what it should tell you about");
    if (input.recipients.length === 0) throw new HomeError("Choose who to tell");

    const data = {
        name,
        placeId: input.placeId,
        cameraId: input.cameraId,
        kinds: JSON.stringify([...input.kinds]),
        label: input.label,
        zones: JSON.stringify([...input.zones]),
        hours: input.hours ? JSON.stringify(input.hours) : null,
        recipients: JSON.stringify([...input.recipients]),
        enabled: input.enabled
    };

    if (id) {
        const existing = await prisma.alertRule.findFirst({
            where: { id, installedAppId },
            select: { id: true, recipients: true, channelId: true }
        });
        if (!existing) throw new HomeError("Alert not found");
        // Its conversation follows the rule: somebody added to an alert should
        // see the ones that come after, and somebody taken off should stop
        // seeing them.
        if (existing.channelId) await syncMembers(existing.channelId, input.recipients);
        return toView(await prisma.alertRule.update({ where: { id }, data }));
    }
    return toView(
        await prisma.alertRule.create({ data: { ...data, installedAppId, createdById: actorId } })
    );
}

export async function deleteAlertRule(installedAppId: string, id: string): Promise<void> {
    const existing = await prisma.alertRule.findFirst({
        where: { id, installedAppId },
        select: { id: true }
    });
    if (!existing) throw new HomeError("Alert not found");
    // The conversation stays. What it holds is a record of things that actually
    // happened, and deleting the rule that reported them is not a reason to take
    // that away from the people who were told.
    await prisma.alertRule.delete({ where: { id } });
}

/** Everybody the rule tells, as members of its conversation. */
async function syncMembers(channelId: string, recipients: readonly string[]): Promise<void> {
    const wanted = new Set(recipients);
    const current = await prisma.chatChannelMember.findMany({
        where: { channelId },
        select: { userId: true }
    });
    const present = new Set(current.map((row) => row.userId));

    const added = [...wanted].filter((id) => !present.has(id));
    if (added.length > 0) {
        await prisma.chatChannelMember.createMany({
            data: added.map((userId) => ({ channelId, userId })),
            skipDuplicates: true
        });
    }
    const removed = [...present].filter((id) => !wanted.has(id));
    if (removed.length > 0) {
        await prisma.chatChannelMember.deleteMany({
            where: { channelId, userId: { in: removed } }
        });
    }
}

/** The conversation a rule posts into, made on first use. */
async function conversationFor(rule: AlertRuleView, actorId: string | null): Promise<string> {
    if (rule.channelId) return rule.channelId;
    const channel = await prisma.chatChannel.create({
        data: {
            kind: "group",
            name: rule.name,
            private: true,
            ...(actorId ? { createdById: actorId } : {}),
            members: { createMany: { data: rule.recipients.map((userId) => ({ userId })) } }
        },
        select: { id: true }
    });
    await prisma.alertRule.update({ where: { id: rule.id }, data: { channelId: channel.id } });
    publishChatChange({
        channelId: channel.id,
        kind: "channels",
        actorId: "",
        audience: [...rule.recipients]
    });
    return channel.id;
}

/** Whether one detection is what a rule was written for. */
function matches(
    rule: AlertRuleView,
    detection: Detection,
    cameraId: string,
    placeId: string | null,
    onlyZones?: readonly string[]
): boolean {
    if (!rule.enabled) return false;
    // A second look at an event that has since walked into somewhere. Only the
    // rules that named one of the areas it has just entered are in play: every
    // other rule already had its chance when the event was opened, and firing
    // them again would tell somebody twice about one arrival.
    if (onlyZones && !rule.zones.some((zone) => onlyZones.includes(zone))) return false;
    if (rule.cameraId && rule.cameraId !== cameraId) return false;
    if (rule.placeId && rule.placeId !== placeId) return false;
    if (!rule.kinds.includes(detection.kind)) return false;
    // A rule about one person only fires for that person. A rule about nobody in
    // particular fires for everybody, strangers included - which is usually the
    // point of writing one.
    if (rule.label && rule.label !== detection.label) return false;
    // "A person in the driveway", rather than "a person". A rule that names
    // areas only fires for something that was standing in one of them; a
    // detection that carries no areas at all - a camera's own alert, or a
    // camera nobody has drawn on - can never satisfy one, which is right: the
    // rule asked a question that camera cannot answer.
    if (rule.zones.length > 0) {
        const seen = detection.zones ?? [];
        if (!rule.zones.some((zone) => seen.includes(zone))) return false;
    }
    if (rule.hours && !withinHours({ hours: rule.hours } as never, new Date().getHours()))
        return false;
    return true;
}

/** What the message says. One line, in the words somebody would use, and a link
 *  to the moment - an alert nobody can act on is a notification. */
function body(
    detection: Detection,
    cameraName: string,
    placeName: string,
    eventId: string
): string {
    const who =
        detection.kind === "face" && detection.label
            ? detection.label
            : detection.kind === "person"
              ? "Somebody"
              : detection.kind === "vehicle"
                ? "A vehicle"
                : detection.kind === "animal"
                  ? "An animal"
                  : detection.kind === "package"
                    ? "Something was left"
                    : detection.kind === "tamper"
                      ? "Somebody may have tampered with a camera"
                      : "Movement";
    // The area is the useful half of "where" once somebody has drawn one: "at
    // the front door" is a sentence, "at Front camera" is a device name.
    const area = detection.zones?.[0];
    const where = [area, cameraName, placeName].filter(Boolean).join(", ");
    return `${who} at **${where}** - [see it](/places/events?event=${eventId})`;
}

/**
 * Deliver an alert for one detection, if any rule asked for it.
 *
 * Never throws: an event that was recorded must not be reported as a failure
 * because a message could not be written, and the event itself is already in the
 * log either way.
 */
export async function raiseAlerts(
    installedAppId: string,
    detection: Detection,
    eventId: string,
    camera: { id: string; name: string; placeId: string | null },
    /** The areas this event has entered since it was opened. Set only on the
     *  second and later looks, and it narrows the rules considered to the ones
     *  that named one of them. */
    onlyZones?: readonly string[]
): Promise<void> {
    try {
        const rules = (await listAlertRules(installedAppId)).filter((rule) =>
            matches(rule, detection, camera.id, camera.placeId, onlyZones)
        );
        if (rules.length === 0) return;

        const place = camera.placeId
            ? await prisma.place.findFirst({
                  where: { id: camera.placeId },
                  select: { name: true }
              })
            : null;
        // Named after where it has just walked into rather than where it came
        // in: "somebody at the driveway" is only a useful sentence if the
        // driveway is what set it off.
        const text = body(
            onlyZones
                ? { ...detection, zones: [...onlyZones, ...(detection.zones ?? [])] }
                : detection,
            camera.name,
            place?.name ?? "",
            eventId
        );

        for (const rule of rules) {
            const channelId = await conversationFor(rule, rule.recipients[0] ?? null);
            await prisma.chatMessage.create({
                data: { channelId, kind: "system", authorId: null, body: text }
            });
            // Unlike a join notice, this one moves the conversation and lights
            // it: being told is the whole purpose, and a room that stays quiet
            // is a room somebody finds two days later.
            await prisma.chatChannel.update({
                where: { id: channelId },
                data: { lastMessageAt: new Date() }
            });
            // No actor: a camera saw it, not a person, so every recipient's tab
            // wakes rather than one of them skipping its own write.
            publishChatChange({
                channelId,
                kind: "posted",
                actorId: "",
                audience: [...rule.recipients]
            });
        }
    } catch (error) {
        console.error("polaris: an alert could not be delivered:", error);
    }
}

/**
 * The people the house knows by sight.
 *
 * Polaris keeps a name and the id that name answers to in the recognizer, and
 * nothing else. The face itself - the photographs, and the template derived from
 * them - lives in whichever recognition service the operator installed and stays
 * on that machine. That is deliberate and it is the whole design: a Polaris
 * database that never holds biometric data cannot leak biometric data, and
 * removing somebody here removes them in both places rather than leaving a face
 * behind in the service nobody thinks to look at.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { faceEndpoint } from "@/lib/home/recognizer";
import { FACE_EXTENSION, type FaceImageType } from "@/lib/home/face-image";

export interface PersonView {
    readonly id: string;
    readonly name: string;
    /**
     * What the recognizer files their photographs under, and the label it puts on
     * an event. Set from the name when they were written down and never changed
     * afterwards: it is the recognizer's key, so renaming somebody here must not
     * move it or every photograph already taught would belong to a stranger.
     *
     * On screen it is only ever a lookup key - what a person is called is `name`.
     */
    readonly subjectId: string;
    readonly notify: boolean;
    /** How many photographs the recognizer holds for them. The number that
     *  matters: one photograph recognizes somebody in that exact light, and four
     *  or five recognizes a person. */
    readonly faces: number;
}

/** Everybody the house knows, alphabetically. Small by nature - it is a
 *  household - so it is one query and no paging. */
export async function listPeople(installedAppId: string): Promise<PersonView[]> {
    const rows = await prisma.homePerson.findMany({
        where: { installedAppId },
        orderBy: { name: "asc" }
    });
    const counts = await faceCounts();
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        subjectId: row.subjectId,
        notify: row.notify,
        faces: counts.get(row.subjectId) ?? 0
    }));
}

/** How many photographs the recognizer holds per subject. One call rather than
 *  one per person, and an empty map when there is no recognizer - a house that
 *  has not installed one still lists the names it wrote down. */
async function faceCounts(): Promise<Map<string, number>> {
    const endpoint = await faceEndpoint();
    if (!endpoint) return new Map();
    const response = await fetch(`${endpoint.baseUrl}/api/v1/recognition/faces?size=1000`, {
        headers: { "x-api-key": endpoint.apiKey }
    }).catch(() => null);
    if (!response?.ok) return new Map();
    const body = (await response.json().catch(() => null)) as { faces?: { subject: string }[] } | null;
    const counts = new Map<string, number>();
    for (const face of body?.faces ?? []) counts.set(face.subject, (counts.get(face.subject) ?? 0) + 1);
    return counts;
}

/**
 * A subject nobody in this house already answers to.
 *
 * Normally the name as typed, because it is what turns up as the label on an
 * event and the two should read the same. Not always, though, and the exception
 * is the whole reason this function exists: renaming somebody leaves their old
 * name free while their subject keeps it, so writing down a second person under
 * that freed name would file both of them under one subject - and then a
 * photograph taught for one is a face the recognizer answers with the other.
 * That is the exact harm the subject was split from the name to prevent.
 *
 * The loop terminates: there are finitely many people in a house, so some
 * suffix is always free.
 */
async function freeSubject(installedAppId: string, name: string): Promise<string> {
    const rows = await prisma.homePerson.findMany({ where: { installedAppId }, select: { subjectId: true } });
    const taken = new Set(rows.map((row) => row.subjectId));
    if (!taken.has(name)) return name;
    for (let suffix = 2; ; suffix++) {
        const candidate = `${name} ${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** Write somebody down. The subject is normally the name as typed: it is what
 *  the recognizer files photographs under and what turns up as the label on an
 *  event, so the two should read the same. */
export async function addPerson(installedAppId: string, name: string): Promise<PersonView> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Give them a name");
    const row = await prisma.homePerson.create({
        data: { installedAppId, name: trimmed, subjectId: await freeSubject(installedAppId, trimmed) }
    });
    return { id: row.id, name: row.name, subjectId: row.subjectId, notify: row.notify, faces: 0 };
}

/**
 * Change what somebody is called.
 *
 * Only the name: their subject in the recognizer stays exactly where it was, so
 * the photographs already taught still belong to them and an event that arrives
 * a second later still matches. It is the reason the two are separate columns at
 * all - correcting a typo must not cost somebody their face.
 *
 * Events recorded before the change keep the subject they were written with, and
 * they read back under the new name because the screen resolves the subject
 * rather than storing the label twice.
 */
export async function renamePerson(installedAppId: string, id: string, name: string): Promise<PersonView> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Give them a name");
    const person = await prisma.homePerson.findFirst({ where: { id, installedAppId }, select: { id: true } });
    if (!person) throw new Error("Not found");
    const row = await prisma.homePerson.update({ where: { id }, data: { name: trimmed } });
    const counts = await faceCounts();
    return {
        id: row.id,
        name: row.name,
        subjectId: row.subjectId,
        notify: row.notify,
        faces: counts.get(row.subjectId) ?? 0
    };
}

/** Whether seeing them is worth reporting. Off by default: a household is taught
 *  to the recognizer so that it STOPS raising alerts about them, not so that
 *  every arrival home becomes one. */
export async function setNotify(installedAppId: string, id: string, notify: boolean): Promise<void> {
    const person = await prisma.homePerson.findFirst({ where: { id, installedAppId }, select: { id: true } });
    if (!person) throw new Error("Not found");
    await prisma.homePerson.update({ where: { id }, data: { notify } });
}

/**
 * Teach the recognizer a face.
 *
 * The photograph goes straight to the recognizer and is never written down here.
 * It answers with nothing Polaris keeps either - the count on the screen is read
 * back from it, so what the screen says is what the recognizer actually holds.
 */
export async function addFace(
    installedAppId: string,
    id: string,
    image: Uint8Array,
    /** What the file is, already narrowed to a format the recognizer reads. */
    contentType: FaceImageType = "image/jpeg"
): Promise<void> {
    const person = await prisma.homePerson.findFirst({ where: { id, installedAppId }, select: { subjectId: true } });
    if (!person) throw new Error("Not found");
    const endpoint = await faceEndpoint();
    if (!endpoint) throw new Error("Face recognition is not set up yet");

    const form = new FormData();
    // Sent as what it is, name and all. The recognizer Home installs reads the
    // bytes and would not care, but the address field is still there for a house
    // running its own - and a service handed WebP bytes labelled as a JPEG is
    // entitled to refuse them.
    form.append("file", new Blob([image], { type: contentType }), `face${FACE_EXTENSION[contentType]}`);
    const response = await fetch(
        `${endpoint.baseUrl}/api/v1/recognition/faces?subject=${encodeURIComponent(person.subjectId)}`,
        { method: "POST", headers: { "x-api-key": endpoint.apiKey }, body: form }
    ).catch(() => null);
    if (!response?.ok) {
        // The recognizer's own complaint is the useful one here: "no face is
        // visible in the file provided" is an answer somebody can act on, and
        // "that did not work" is not.
        const detail = (await response?.json().catch(() => null)) as { message?: string } | null;
        throw new Error(detail?.message ?? "The recognizer would not take that photograph");
    }
}

/**
 * Forget somebody, here and there.
 *
 * The recognizer first: a row removed while the face stayed behind would leave a
 * template in a service with nothing in Polaris pointing at it, which is exactly
 * the biometric leftover this design exists to prevent. If the recognizer cannot
 * be reached, the removal fails and says so rather than half-happening.
 */
export async function removePerson(installedAppId: string, id: string): Promise<void> {
    const person = await prisma.homePerson.findFirst({ where: { id, installedAppId }, select: { subjectId: true } });
    if (!person) throw new Error("Not found");
    const endpoint = await faceEndpoint();
    if (endpoint) {
        const response = await fetch(
            `${endpoint.baseUrl}/api/v1/recognition/subjects/${encodeURIComponent(person.subjectId)}`,
            { method: "DELETE", headers: { "x-api-key": endpoint.apiKey } }
        ).catch(() => null);
        // A subject the recognizer has never heard of is already forgotten, which
        // is the state being asked for.
        if (response && !response.ok && response.status !== 404) {
            throw new Error("The recognizer would not forget them, so nothing was removed");
        }
    }
    await prisma.homePerson.delete({ where: { id } });
}

/**
 * Telling somebody that a service lost, or got back, the NAS its volumes live on.
 *
 * A service whose volumes went away keeps running and keeps answering, so nothing
 * else on the screen turns red: the files it reads come back "Host is down" and
 * the first anybody hears of it is a user of that service. This is the notice that
 * says it first, to the service's owner and to whoever follows the service.
 */

import { notify } from "./dispatch";
import { prisma } from "@polaris/db";
import { wordsFor } from "./notice-words";
import * as follow from "../follow/follow";

/** What happened to a service's NAS volumes. */
export type VolumeHealth =
    /** The storage they live on does not answer. */
    | "unreachable"
    /** The storage answers, but the volumes inside the service do not, even after
     *  a restart. */
    | "detached"
    /** They answer again. */
    | "back"
    /** The connection had dropped; Polaris made it again and restarted the
     *  service onto it. */
    | "reconnected";

const TITLE = {
    unreachable: "volume.downTitle",
    detached: "volume.downTitle",
    back: "volume.backTitle",
    reconnected: "volume.reconnectedTitle"
} as const;

const BODY = {
    unreachable: "volume.unreachableBody",
    detached: "volume.detachedBody",
    back: "volume.backBody",
    reconnected: "volume.reconnectedBody"
} as const;

/** One service and the NAS volumes the notice is about. */
export interface VolumeSubject {
    applicationId: string;
    /** The storage the volumes live on, by the name it was given in Polaris. */
    storage: string;
    /** The volumes' names. */
    volumes: readonly string[];
}

/**
 * Raise the notice. Never throws: it runs inside the watcher and the remount, and
 * a service that already lost its files must not also lose the restart.
 */
export async function notifyVolumeHealth(
    subject: VolumeSubject,
    health: VolumeHealth
): Promise<void> {
    try {
        const app = await prisma.application.findUnique({
            where: { id: subject.applicationId },
            select: {
                name: true,
                environment: {
                    select: {
                        project: { select: { id: true, name: true, ownerId: true, orgId: true } }
                    }
                }
            }
        });
        if (!app) return;
        const project = app.environment.project;
        const service = `${project.name} / ${app.name}`;
        const recipients = new Set([project.ownerId]);
        for (const userId of await follow.followers("app", subject.applicationId))
            recipients.add(userId);
        const down = health === "unreachable" || health === "detached";
        for (const userId of recipients) {
            const t = await wordsFor(userId, "notices");
            const words = {
                service,
                storage: subject.storage,
                volumes: subject.volumes.join(", ")
            };
            await notify({
                userId,
                event: down ? "volume.down" : "volume.up",
                title: t(TITLE[health], words),
                body: t(BODY[health], words),
                href: `/apps/deploy/${project.id}?service=${subject.applicationId}`,
                shelf: { orgId: project.orgId },
                actionRequired: down,
                // A reconnect is good news about something that went wrong: not a
                // success in green, which reads as nothing having happened.
                level: health === "reconnected" ? "info" : undefined,
                metadata: { applicationId: subject.applicationId, health }
            });
        }
    } catch (error) {
        console.error(
            `polaris: could not tell anybody about the volumes of ${subject.applicationId}:`,
            error
        );
    }
}

/**
 * A service's restart policy, as Railway offers it: never start an exited
 * container again, start it again only when it fails - up to a number of times -
 * or always. The stored default is "always", what every service ran with before
 * the setting existed, so an install that never opens it deploys as it did.
 */

import { prisma } from "@polaris/db";
import type { RestartPolicy } from "@polaris/deploy";
import { restartPolicySchema } from "./restart-policy-schema";

export { restartPolicySchema };

/** The policy a deploy runs with, from the stored columns; anything unknown is
 *  "always". */
export function restartPolicyOf(app: {
    readonly restartPolicy: string;
    readonly restartMaxRetries: number;
}): RestartPolicy {
    const parsed = restartPolicySchema.safeParse({
        policy: app.restartPolicy,
        maxRetries: app.restartMaxRetries
    });
    return parsed.success ? parsed.data : { policy: "always", maxRetries: 10 };
}

export async function readRestartPolicy(
    applicationId: string,
    ownerId: string
): Promise<RestartPolicy> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { restartPolicy: true, restartMaxRetries: true }
    });
    if (!app) throw new Error("Application not found");
    return restartPolicyOf(app);
}

/** Store a policy; the next deploy applies it. False when nothing changed. */
export async function setRestartPolicy(
    applicationId: string,
    ownerId: string,
    next: RestartPolicy
): Promise<boolean> {
    const current = await readRestartPolicy(applicationId, ownerId);
    if (current.policy === next.policy && current.maxRetries === next.maxRetries) return false;
    await prisma.application.update({
        where: { id: applicationId },
        data: { restartPolicy: next.policy, restartMaxRetries: next.maxRetries }
    });
    return true;
}

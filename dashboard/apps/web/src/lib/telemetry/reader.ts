/**
 * Who gets into Telemetry, kept out of the action module so it is not itself an
 * action a browser could call.
 */

import { grantedSubjects } from "@/lib/access/grants";
import type { TelemetryActor } from "@/lib/telemetry/project-service";
import { requirePermission, requireUser, sessionCan } from "@/lib/session";

/**
 * Who may read Telemetry: whoever runs services, or somebody a project was
 * shared with (`telemetry.project`), who reads only those. Anybody else is
 * turned away as before. `lent` is the set of shared projects, passed to the
 * reads; `editable` is the part of it shared as `edit`, which is the only set
 * passed to anything that changes a project.
 */
export async function requireTelemetryReader(): Promise<{
    actor: TelemetryActor;
    lent: ReadonlySet<string>;
    editable: ReadonlySet<string>;
    /** Whether this account runs services, which is what making a project of
     *  its own takes. */
    manages: boolean;
}> {
    const user = await requireUser();
    const [manages, held] = await Promise.all([
        sessionCan(user, "deploy.manage"),
        grantedSubjects(user.id, "telemetry.project")
    ]);
    if (!manages && held.size === 0) await requirePermission("deploy.manage");
    const editable = new Set(
        [...held].filter(([, capability]) => capability === "edit").map(([id]) => id)
    );
    return {
        actor: { id: user.id, isAdmin: user.isAdmin },
        lent: new Set(held.keys()),
        editable,
        manages
    };
}

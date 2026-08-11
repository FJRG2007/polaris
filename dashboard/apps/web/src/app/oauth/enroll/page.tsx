/**
 * The enrollment step (/oauth/enroll). Shown when this deployment requires every
 * account to carry a second factor and this one carries none.
 *
 * It stands between a valid session and the dashboard, which is what makes the
 * requirement retroactive: an account made years ago meets it the first time it
 * navigates after an administrator turns it on, with no migration and no invite to
 * re-send. The session itself is untouched - the person is signed in, they simply
 * have one thing left to do.
 *
 * Resolves the session directly rather than through requireUser, which would send
 * them back here forever.
 */

import { redirect } from "next/navigation";
import { EnrollView } from "./enroll-view";
import { resolveSession } from "@/lib/session";
import { enrollmentOptions, owesSecondFactor } from "@/lib/instance-security";

export const dynamic = "force-dynamic";

export default async function EnrollPage() {
    const session = await resolveSession();
    if (!session) redirect("/oauth/login");
    // Nothing owed means nothing to do here, including for somebody who has just
    // finished: the redirect out is what ends the flow.
    if (!(await owesSecondFactor(session.id))) redirect("/");

    const options = await enrollmentOptions(session.id);
    return <EnrollView account={session.email} name={session.name} options={options} />;
}

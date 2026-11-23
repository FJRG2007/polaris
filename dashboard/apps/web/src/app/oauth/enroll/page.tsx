/**
 * The enrollment step (/oauth/enroll). Shown when this deployment requires every
 * account to carry a second factor and this one carries none, or to have a
 * confirmed phone and this one has none - the factor first, then the phone.
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
import { getUserPhone } from "@polaris/auth";
import { PhoneStep } from "./phone-step";
import { EnrollView } from "./enroll-view";
import { resolveSession } from "@/lib/session";
import { Messages } from "@/components/i18n/messages";
import { enrollmentOptions, owesPhone, owesSecondFactor } from "@/lib/instance-security";

export const dynamic = "force-dynamic";

export default async function EnrollPage() {
    const session = await resolveSession();
    if (!session) redirect("/oauth/login");
    // Nothing owed means nothing to do here, including for somebody who has just
    // finished: the redirect out is what ends the flow.
    if (await owesSecondFactor(session.id)) {
        const options = await enrollmentOptions(session.id);
        return <EnrollView account={session.email} name={session.name} options={options} />;
    }
    if (!(await owesPhone(session.id))) redirect("/");

    // The phone card's own words live with the account screens it comes from.
    return (
        <Messages namespaces={["account", "accountSecurity", "common"]}>
            <PhoneStep name={session.name} phone={await getUserPhone(session.id)} />
        </Messages>
    );
}

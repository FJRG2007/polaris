/**
 * Account page (/account/details): the plumbing behind the profile - the name
 * held on the account, the addresses it signs in and is reached at, and the
 * number a code is sent to.
 *
 * The profile it was split out of stays at /account, so nothing that linked to
 * it moved. What moved here is everything that is NOT published, which is the
 * line between the two screens: /account is what a colleague sees, this is how
 * Polaris reaches you. Credentials, sessions and second factors keep their own
 * screens under Security.
 *
 * Server component that loads the editable fields and hands them to the client
 * view.
 */

import { getTranslations } from "@/lib/i18n/request";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { AccountView } from "./account-view";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { getUserPhone, listUserEmails } from "@polaris/auth";
import { getInstanceSecurity } from "@/lib/instance-security";
import { phoneCodeRoute } from "@/lib/messaging/code-senders";

export const dynamic = "force-dynamic";

export default async function AccountDetailsPage() {
    const session = await requireUser();
    const t = await getTranslations("account");
    const [user, emails, mail, phone, phoneRoute, instancePolicy] = await Promise.all([
        prisma.user.findUnique({
            where: { id: session.id },
            select: { firstName: true, lastName: true, secondLastName: true }
        }),
        listUserEmails(session.id),
        getAuthMailStatus(),
        getUserPhone(session.id),
        // Confirming a number is sent the same way a sign-in code is - the
        // deployment's sender or the account's own channel - so the card needs to
        // know whether there is anything to send with.
        phoneCodeRoute(session.id),
        // Whether the instance requires a phone, which the card says and which
        // keeps it from being removed. Administrators are never held by it.
        getInstanceSecurity()
    ]);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("details.page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("details.page.intro")}</p>
            </div>
            <AccountView
                firstName={user?.firstName ?? ""}
                lastName={user?.lastName ?? ""}
                secondLastName={user?.secondLastName ?? ""}
                emails={emails}
                mailReady={mail.channelId !== null}
                phone={phone}
                canSendWhatsApp={phoneRoute !== null}
                phoneRequired={instancePolicy.requirePhone && !session.isAdmin}
            />
        </div>
    );
}

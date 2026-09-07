/**
 * What the connect dialog has to know before anybody types anything.
 *
 * Which outside accounts this person has already authorized, whether each of
 * them was granted what a mailbox needs rather than only what a calendar needs,
 * and whether the operator has connected the application at all - without which
 * the Authorize button could only ever fail, and saying so is more use than a
 * consent page that will not load.
 *
 * Read in one place because two screens ask for it: the settings list, and the
 * onboarding somebody sees before there is a mailbox to settle into.
 */

import { prisma } from "@polaris/db";
import { grantsMailAccess } from "./credentials";
import { publicAppUrl } from "@/lib/domain-service";
import { getIntegrationState } from "@/lib/integration-service";

export interface MailConnectOptions {
    readonly links: {
        readonly id: string;
        readonly provider: string;
        readonly label: string;
        readonly readyForMail: boolean;
    }[];
    readonly googleReady: boolean;
    readonly microsoftReady: boolean;
    /**
     * Whether this dashboard has an address the outside world can return
     * somebody to.
     *
     * False on a LAN-only install, and it is the difference between a button
     * that authorizes a mailbox and one that walks somebody through a consent
     * screen and leaves them on an address their browser cannot resolve. The
     * screen says which, because the two look identical until it is too late.
     */
    readonly publicAddress: boolean;
}

export async function mailConnectOptions(userId: string): Promise<MailConnectOptions> {
    const [links, google, microsoft, publicUrl] = await Promise.all([
        prisma.userConnection.findMany({
            where: { userId, provider: { in: ["google", "microsoft"] } },
            select: { id: true, provider: true, label: true, scope: true },
            orderBy: { linkedAt: "desc" }
        }),
        getIntegrationState("google"),
        getIntegrationState("microsoft"),
        publicAppUrl()
    ]);

    return {
        links: links.map((link) => ({
            id: link.id,
            provider: link.provider,
            label: link.label,
            readyForMail: grantsMailAccess(link.provider, link.scope)
        })),
        // An application is only offerable once the operator has connected it
        // AND left it on. Either half missing is a button that cannot work, and
        // so is a dashboard the provider cannot return anybody to.
        googleReady: Boolean(google?.enabled && google.hasSecret && publicUrl),
        microsoftReady: Boolean(microsoft?.enabled && microsoft.hasSecret && publicUrl),
        publicAddress: Boolean(publicUrl)
    };
}

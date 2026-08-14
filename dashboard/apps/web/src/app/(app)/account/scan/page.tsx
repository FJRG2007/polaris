/**
 * Scan a code (/account/scan): the other half of the QR on the sign-in screen.
 * A device already signed in reads the code - with the camera here, from the
 * link the phone's own camera opened, or by typing it - and decides whether to
 * let that sign-in through.
 *
 * The code arrives as a query parameter, so it is resolved here rather than in
 * the browser: what is shown about the waiting sign-in has to come from the
 * request that opened it, and whether there is anything to decide at all is not
 * a question the client can be trusted to answer.
 */

import { ScanView } from "./scan-view";
import { requireUser } from "@/lib/session";
import { ScanHistory } from "./scan-history";
import { getUserSecurity } from "@polaris/auth";
import { qrUserCodeField } from "@polaris/core";
import { describeSignInCode, listQrSignInAnswers } from "@/lib/qr-sign-in-service";

export const dynamic = "force-dynamic";

export default async function ScanPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await requireUser();
    const params = await searchParams;
    const raw = typeof params.code === "string" ? params.code : null;
    const parsed = raw ? qrUserCodeField.safeParse(raw) : null;
    const [request, security, answers] = await Promise.all([
        parsed?.success ? describeSignInCode(parsed.data, user.id) : null,
        getUserSecurity(user.id),
        listQrSignInAnswers(user.id, user.sessionId)
    ]);

    return (
        <div className="mx-auto flex max-w-xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">Scan a code</h1>
                <p className="text-sm text-muted-foreground">
                    Let a sign-in through on a device that cannot ask for your password.
                </p>
            </div>
            <ScanView request={request} scanned={raw !== null} hasPin={security.hasPin} />
            {/* Every code this account has answered, under the thing that answers
                them. A code allowed by mistake is noticed here or not at all: the
                session it opened looks like any other sign-in on the list. */}
            <ScanHistory answers={answers} />
        </div>
    );
}

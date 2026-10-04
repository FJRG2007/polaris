import { INVITE_REFUSALS } from "@polaris/core";
import { clientIp } from "@/lib/request-context";
import { InviteCodeForm } from "./invite-code-form";
import { resolveInvite } from "@/lib/invite-service";
import { AcceptInviteForm } from "./accept-invite-form";
import { getTranslations } from "@/lib/i18n/request";
import { validationMessage } from "@/components/i18n/validation-message";
import { Card, CardBody, CardHeader, CardTitle, PolarisMark } from "@polaris/ui";

export const dynamic = "force-dynamic";

export default async function AcceptInvitePage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const token = typeof params.token === "string" ? params.token : "";

    // No token means the recipient was handed a code instead of a link: ask for
    // it rather than telling them their invite is unusable.
    if (!token) return <InviteCodeForm />;

    const { invite, refusal } = await resolveInvite({ token }, await clientIp());
    if (!invite) {
        const t = await getTranslations("auth");
        const tv = await getTranslations("validation");
        return (
            <main className="grid min-h-dvh place-items-center p-4">
                <Card className="w-full max-w-sm">
                    <CardHeader className="items-center">
                        <PolarisMark className="mb-1" />
                        <CardTitle>{t("invite.unavailableTitle")}</CardTitle>
                    </CardHeader>
                    <CardBody>
                        <p className="text-sm text-muted-foreground">
                            {validationMessage(tv, INVITE_REFUSALS[refusal ?? "unavailable"])}
                        </p>
                        <a
                            href="/oauth/login"
                            className="mt-4 block text-center text-sm text-primary hover:underline"
                        >
                            {t("invite.goToSignIn")}
                        </a>
                    </CardBody>
                </Card>
            </main>
        );
    }

    return (
        <AcceptInviteForm
            token={token}
            email={invite.email}
            needsPassword={invite.needsPassword}
            orgName={invite.orgName}
        />
    );
}

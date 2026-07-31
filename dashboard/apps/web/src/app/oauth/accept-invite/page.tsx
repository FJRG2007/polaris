import { INVITE_REFUSALS } from "@polaris/core";
import { Card, CardBody, CardHeader, CardTitle, PolarisMark } from "@polaris/ui";
import { clientIp } from "@/lib/request-context";
import { resolveInvite } from "@/lib/invite-service";
import { AcceptInviteForm } from "./accept-invite-form";
import { InviteCodeForm } from "./invite-code-form";

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
        return (
            <main className="grid min-h-screen place-items-center p-4">
                <Card className="w-full max-w-sm">
                    <CardHeader className="items-center">
                        <PolarisMark className="mb-1" />
                        <CardTitle>Invite unavailable</CardTitle>
                    </CardHeader>
                    <CardBody>
                        <p className="text-sm text-muted-foreground">{INVITE_REFUSALS[refusal ?? "unavailable"]}</p>
                        <a href="/oauth/login" className="mt-4 block text-center text-sm text-primary hover:underline">
                            Go to sign in
                        </a>
                    </CardBody>
                </Card>
            </main>
        );
    }

    return <AcceptInviteForm token={token} email={invite.email} needsPassword={invite.needsPassword} />;
}

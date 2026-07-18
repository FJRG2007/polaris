import { Card, CardBody, CardHeader, CardTitle, PolarisMark } from "@polaris/ui";
import { findValidInvite } from "@/lib/invite-service";
import { AcceptInviteForm } from "./accept-invite-form";

export const dynamic = "force-dynamic";

export default async function AcceptInvitePage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const token = typeof params.token === "string" ? params.token : "";
    const invite = token ? await findValidInvite(token) : null;

    if (!invite) {
        return (
            <main className="grid min-h-screen place-items-center p-4">
                <Card className="w-full max-w-sm">
                    <CardHeader className="items-center">
                        <PolarisMark className="mb-1" />
                        <CardTitle>Invite unavailable</CardTitle>
                    </CardHeader>
                    <CardBody>
                        <p className="text-sm text-muted-foreground">
                            This invite link is invalid, expired, or already used. Ask an
                            administrator for a new one.
                        </p>
                        <a href="/login" className="mt-4 block text-center text-sm text-primary hover:underline">
                            Go to sign in
                        </a>
                    </CardBody>
                </Card>
            </main>
        );
    }

    return <AcceptInviteForm token={token} email={invite.email} />;
}

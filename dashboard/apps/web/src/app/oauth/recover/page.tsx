import { RecoverForm } from "./recover-form";

export const dynamic = "force-dynamic";

export default async function RecoverPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    // Coming back to a request already raised: the ticket is the whole state, so
    // the page picks up wherever the decision has got to.
    const params = await searchParams;
    return <RecoverForm initialTicket={typeof params.ticket === "string" ? params.ticket : ""} />;
}

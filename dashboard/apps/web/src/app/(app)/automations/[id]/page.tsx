/**
 * One automation's editor (/automations/[id]). The shell paints at once; the
 * automation is fetched by the client.
 */

import { AutomationEditor } from "./automation-editor";

export const dynamic = "force-dynamic";

export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <div className="mx-auto w-full max-w-4xl">
            <AutomationEditor id={id} />
        </div>
    );
}

import { AlertsView } from "./alerts-view";

export const dynamic = "force-dynamic";

export default function AlertsPage() {
    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
            <AlertsView />
        </div>
    );
}

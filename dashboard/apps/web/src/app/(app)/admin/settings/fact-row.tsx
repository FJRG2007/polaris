import { Skeleton } from "@polaris/ui";

/** One fact. A null value is one that has not arrived yet - the label is already
 *  right, so it stays and only the answer is a placeholder. */
export function FactRow({
    label,
    value,
    href
}: {
    label: string;
    value: string | null;
    href?: string;
}) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-medium">
                {value === null ? (
                    <Skeleton className="h-4 w-24" />
                ) : href ? (
                    <a
                        className="text-primary hover:underline"
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                    >
                        {value}
                    </a>
                ) : (
                    value
                )}
            </dd>
        </>
    );
}

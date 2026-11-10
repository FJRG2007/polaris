import { SectionSkeleton } from "../section-skeleton";

export default function Loading() {
    return <SectionSkeleton parts={[{ kind: "table", count: 3 }, { kind: "table", count: 3 }, { kind: "rows", count: 2 }]} />;
}

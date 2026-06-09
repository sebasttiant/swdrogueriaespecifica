import { Skeleton } from "@/app/_components/ui/skeleton";

// Product detail loading skeleton — approximates:
// page header + stock card + batch list rows.
export default function ProductDetailLoading() {
  return (
    <div className="space-y-6">
      {/* Page header placeholder */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-32" />
      </div>

      {/* Stock card placeholder */}
      <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-sm space-y-1">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-4 w-64" />
      </div>

      {/* Batch list header + rows placeholder */}
      <div className="space-y-3">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-4/5" />
      </div>
    </div>
  );
}

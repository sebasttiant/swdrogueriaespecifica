import { Skeleton } from "@/app/_components/ui/skeleton";

// Admin user edit loading skeleton — approximates:
// page header + back link + user edit form card.
export default function AdminUserEditLoading() {
  return (
    <div className="space-y-6">
      {/* Page header placeholder */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>

      {/* Back link placeholder */}
      <Skeleton className="h-4 w-32" />

      {/* Edit form card placeholder */}
      <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-sm space-y-4">
        <Skeleton className="h-5 w-48" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>
    </div>
  );
}

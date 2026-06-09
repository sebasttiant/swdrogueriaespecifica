import { Skeleton } from "@/app/_components/ui/skeleton";

// Admin (usuarios) loading skeleton — approximates:
// page header + new user form card + user list rows (mobile cards / desktop table).
export default function AdminLoading() {
  return (
    <div className="space-y-6">
      {/* Page header placeholder */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-80" />
      </div>

      {/* New user form card placeholder */}
      <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-sm space-y-4">
        <Skeleton className="h-5 w-32" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-10 w-36" />
      </div>

      {/* User list placeholder */}
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

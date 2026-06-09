import { Skeleton } from "@/app/_components/ui/skeleton";

// Dashboard loading skeleton — approximates the real layout:
// page header + KPI row + urgencies card + semaphore card.
export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      {/* Page header placeholder */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>

      {/* Estado general card placeholder */}
      <Skeleton className="h-16 w-full" />

      {/* KPI row placeholder */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>

      {/* Quick actions placeholder */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>

      {/* Urgencias + semáforo cards placeholder */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-sm">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-3/4" />
        </div>
        <div className="space-y-3 rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-sm">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-24" />
        </div>
      </div>
    </div>
  );
}

import Link from "next/link";

import {
  missingScopeHref,
  type MissingBoardRoute,
  type MissingQueueScope,
} from "./missing-scope";

export interface MissingManagementPage {
  page: number;
  pageSize: number;
  total: number;
}

export function parseMissingManagementPage(raw?: string): number {
  const page = raw && /^\d+$/.test(raw) ? Number(raw) : 1;
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

type MissingManagementPaginationProps = MissingManagementPage & {
  scope: MissingQueueScope;
  route: MissingBoardRoute;
  bulkMode: boolean;
};

export function MissingManagementPagination({
  page,
  pageSize,
  total,
  scope,
  route,
  bulkMode,
}: MissingManagementPaginationProps) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const href = (target: number) => {
    const base = missingScopeHref(scope, route, bulkMode);
    return `${base}${base.includes("?") ? "&" : "?"}qpage=${target}`;
  };
  const controls = [
    { label: "Anterior", target: page - 1, disabled: page <= 1 },
    { label: "Siguiente", target: page + 1, disabled: end >= total },
  ];

  return (
    <nav
      aria-label="Paginación de faltantes"
      className="flex flex-wrap items-center justify-between gap-3 print:hidden"
    >
      <p className="text-sm text-muted-foreground">
        Mostrando {start}–{end} de {total}
      </p>
      <div className="flex flex-wrap gap-2">
        {controls.map(({ label, target, disabled }) =>
          disabled ? (
            <button
              key={label}
              type="button"
              disabled
              className="min-h-11 rounded-lg border px-4 text-sm opacity-50"
            >
              {label}
            </button>
          ) : (
            <Link
              key={label}
              prefetch={false}
              href={href(target)}
              className="inline-flex min-h-11 items-center rounded-lg border px-4 text-sm font-semibold hover:bg-muted"
            >
              {label}
            </Link>
          ),
        )}
      </div>
    </nav>
  );
}

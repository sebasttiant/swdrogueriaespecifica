import Link from "next/link";
import {
  Activity,
  ClipboardList,
  FileBarChart,
  KeyRound,
  Settings2,
  ShieldCheck,
  UsersRound,
} from "lucide-react";

import { Badge } from "@/app/_components/ui/badge";
import { Card, CardTitle } from "@/app/_components/ui/card";
import { USER_ROLES } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/generated/prisma/client";
import type { UserListItem } from "@/server/repositories/user.repository";

import { ROLE_LABELS } from "./schema";

export type AdminOverviewMetrics = {
  totalVisible: number;
  activeVisible: number;
  archivedVisible: number;
  roleCounts: Record<UserRole, number>;
};

type AdminOverviewProps = {
  items: UserListItem[];
  showArchived: boolean;
};

type AdminModuleCard = {
  title: string;
  description: string;
  href?: string;
  icon: typeof UsersRound;
  status: string;
  statusTone: "neutral" | "success";
};

const MODULES: readonly AdminModuleCard[] = [
  {
    title: "Usuarios y roles",
    description: "Altas, edición, activación, archivo y restauración según jerarquía.",
    href: "#gestion-de-usuarios",
    icon: UsersRound,
    status: "Operativo",
    statusTone: "success",
  },
  {
    title: "Seguridad y permisos",
    description: "Resumen de autoridad por rol y techo de gestión vigente.",
    href: "#seguridad-y-permisos",
    icon: ShieldCheck,
    status: "Definido",
    statusTone: "success",
  },
  {
    title: "Auditoría",
    description: "Consulta de eventos administrativos y operativos registrados.",
    href: "/auditoria",
    icon: ClipboardList,
    status: "Disponible",
    statusTone: "success",
  },
  {
    title: "Reportes",
    description: "Exportaciones y seguimiento gerencial con datos reales del sistema.",
    href: "/reportes",
    icon: FileBarChart,
    status: "Disponible",
    statusTone: "success",
  },
  {
    title: "Operación futura",
    description: "Espacio preparado para configuración operativa sin cambiar permisos hoy.",
    icon: Settings2,
    status: "Planificado",
    statusTone: "neutral",
  },
] as const;

const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  SUPERADMIN: "Control total; puede administrar, archivar y restaurar cuentas.",
  ADMIN: "Administra usuarios y operación, sin elevarse por encima de su jerarquía.",
  SUPERVISOR: "Supervisa operación y confirma faltantes; no administra usuarios.",
  OPERADOR: "Ejecuta operación diaria sin acceso administrativo.",
};

function emptyRoleCounts(): Record<UserRole, number> {
  return {
    SUPERADMIN: 0,
    ADMIN: 0,
    SUPERVISOR: 0,
    OPERADOR: 0,
  };
}

export function getAdminOverviewMetrics(
  items: readonly UserListItem[],
): AdminOverviewMetrics {
  const roleCounts = emptyRoleCounts();

  for (const user of items) {
    roleCounts[user.role] += 1;
  }

  return {
    totalVisible: items.length,
    activeVisible: items.filter((user) => user.active && user.archivedAt === null)
      .length,
    archivedVisible: items.filter((user) => user.archivedAt !== null).length,
    roleCounts,
  };
}

function metricLabel(showArchived: boolean): string {
  return showArchived ? "lista actual" : "página actual";
}

export function AdminOverview({ items, showArchived }: AdminOverviewProps) {
  const metrics = getAdminOverviewMetrics(items);
  const scope = metricLabel(showArchived);

  return (
    <section className="space-y-4" aria-labelledby="admin-overview-title">
      <Card className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-primary">
              Centro administrativo
            </p>
            <h2 id="admin-overview-title" className="mt-1 text-xl font-bold text-text">
              Panel de control de administración
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Vista estructurada de usuarios, roles, permisos y módulos de control.
              Las métricas usan solo los usuarios cargados en la {scope}.
            </p>
          </div>
          <Badge tone="primary">Acceso administrativo</Badge>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">Usuarios en {scope}</p>
            <p className="mt-1 text-3xl font-bold text-text">
              {metrics.totalVisible}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">Activos en {scope}</p>
            <p className="mt-1 text-3xl font-bold text-success">
              {metrics.activeVisible}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">Archivados en {scope}</p>
            <p className="mt-1 text-3xl font-bold text-danger">
              {metrics.archivedVisible}
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-5">
        {MODULES.map((module) => {
          const Icon = module.icon;
          const content = (
            <Card className="h-full space-y-3 transition-colors hover:bg-muted/30">
              <div className="flex items-start justify-between gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <Badge tone={module.statusTone}>
                  {module.status}
                </Badge>
              </div>
              <div>
                <h3 className="font-semibold text-text">{module.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {module.description}
                </p>
              </div>
            </Card>
          );

          if (!module.href) return <div key={module.title}>{content}</div>;

          return (
            <Link key={module.title} href={module.href} className="block h-full">
              {content}
            </Link>
          );
        })}
      </div>

      <div id="seguridad-y-permisos" className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <KeyRound className="size-5" aria-hidden />
            </span>
            <div>
              <CardTitle>Jerarquía de roles</CardTitle>
              <p className="text-sm text-muted-foreground">
                Orden de autoridad vigente para administración de usuarios.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {USER_ROLES.map((role, index) => (
              <div
                key={role}
                className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-bold text-text">
                      {index + 1}
                    </span>
                    <p className="font-semibold text-text">{ROLE_LABELS[role]}</p>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {ROLE_DESCRIPTIONS[role]}
                  </p>
                </div>
                <Badge tone={role === "OPERADOR" ? "neutral" : "primary"}>
                  {metrics.roleCounts[role]} en {scope}
                </Badge>
              </div>
            ))}
          </div>
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-warning/15 text-warning-foreground">
              <Activity className="size-5" aria-hidden />
            </span>
            <div>
              <CardTitle>Reglas activas</CardTitle>
              <p className="text-sm text-muted-foreground">
                Resumen visible, sin cambiar la política de seguridad.
              </p>
            </div>
          </div>
          <ul className="space-y-3 text-sm text-muted-foreground">
            <li className="rounded-xl border border-border p-3">
              SUPERADMIN puede archivar/restaurar usuarios y administrar toda la
              jerarquía.
            </li>
            <li className="rounded-xl border border-border p-3">
              ADMIN administra usuarios hasta su mismo nivel, sin controlar
              SUPERADMIN.
            </li>
            <li className="rounded-xl border border-border p-3">
              SUPERVISOR y OPERADOR no acceden a este módulo de usuarios.
            </li>
          </ul>
        </Card>
      </div>
    </section>
  );
}

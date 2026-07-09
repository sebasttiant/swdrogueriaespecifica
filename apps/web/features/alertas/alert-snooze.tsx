"use client";

import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { Clock } from "lucide-react";

import { Button } from "@/app/_components/ui/button";
import { can } from "@/lib/auth/permissions";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { SessionRole } from "@/lib/auth/session";

const SNOOZE_HOURS = 8;
const SNOOZE_MS = SNOOZE_HOURS * 60 * 60 * 1000;
const SNOOZE_CHANGE_EVENT = "alerts-snooze-change";

type SnoozeEntry = {
  snoozedUntil: number;
  signature: string;
};

const ALERT_SNOOZE_SEVERITY = {
  DANGER: "danger",
  WARNING: "warning",
} as const;

export type AlertSnoozeSeverity =
  (typeof ALERT_SNOOZE_SEVERITY)[keyof typeof ALERT_SNOOZE_SEVERITY];

export type AlertSnoozeChip = {
  severity: AlertSnoozeSeverity;
  label: string;
  count: number;
  href: string;
};

export type AlertSnoozeWrapperProps = {
  userId: string;
  role: SessionRole;
  chips: AlertSnoozeChip[];
  highestSeverity: AlertSnoozeSeverity;
  signature: string;
  totalCount: number;
  children: ReactNode;
};

function storageKey(userId: string): string {
  return `alerts-snooze:${userId}`;
}

function parseSnoozeEntry(raw: string | null): SnoozeEntry | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "snoozedUntil" in parsed &&
      "signature" in parsed &&
      typeof parsed.snoozedUntil === "number" &&
      typeof parsed.signature === "string"
    ) {
      return {
        snoozedUntil: parsed.snoozedUntil,
        signature: parsed.signature,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function canSnooze(role: SessionRole): boolean {
  return can(role, "canSnoozeAlerts");
}

function subscribeToSnoozeChanges(onStoreChange: () => void): () => void {
  window.addEventListener(SNOOZE_CHANGE_EVENT, onStoreChange);
  return () => window.removeEventListener(SNOOZE_CHANGE_EVENT, onStoreChange);
}

function emitSnoozeChange() {
  window.dispatchEvent(new Event(SNOOZE_CHANGE_EVENT));
}

export function AlertSnoozeWrapper({
  userId,
  role,
  signature,
  totalCount,
  children,
}: AlertSnoozeWrapperProps) {
  const key = storageKey(userId);

  const snoozedUntil = useSyncExternalStore(
    subscribeToSnoozeChanges,
    () => {
      const entry = parseSnoozeEntry(window.localStorage.getItem(key));
      if (!entry) return null;

      const isActive = Date.now() < entry.snoozedUntil;
      const hasSameSignature = entry.signature === signature;

      if (isActive && hasSameSignature) {
        return entry.snoozedUntil;
      }

      if (!isActive) {
        window.localStorage.removeItem(key);
      }
      return null;
    },
    () => null,
  );

  function snoozeAlerts() {
    if (!canSnooze(role)) return;

    const nextSnoozedUntil = Date.now() + SNOOZE_MS;
    const entry: SnoozeEntry = { snoozedUntil: nextSnoozedUntil, signature };

    window.localStorage.setItem(key, JSON.stringify(entry));
    emitSnoozeChange();
  }

  if (snoozedUntil) {
    return (
      <div className="px-4 pt-4 lg:px-8">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 rounded-full border border-warning/30 bg-warning/10 px-4 py-2 text-sm font-medium text-warning-foreground">
          <span>
            avisos pospuestos · vuelven{" "}
            {formatBogotaDate(new Date(snoozedUntil), { style: "time" })} ·{" "}
            {totalCount}
          </span>
          <button
            type="button"
            className="text-xs font-semibold underline underline-offset-4"
            onClick={() => {
              window.localStorage.removeItem(key);
              emitSnoozeChange();
            }}
          >
            Ver ahora
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-4 lg:px-8">
      <div className="mx-auto w-full max-w-5xl">
        {children}
        {canSnooze(role) ? (
          <div className="mt-2 flex sm:justify-end">
            <Button
              variant="outline"
              size="md"
              className="w-full justify-center gap-2 text-sm sm:w-auto"
              onClick={snoozeAlerts}
            >
              <Clock className="size-4" aria-hidden />
              Posponer 8 h
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

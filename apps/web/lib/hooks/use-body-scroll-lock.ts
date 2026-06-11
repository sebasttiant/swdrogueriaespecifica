"use client";

import { useEffect } from "react";

// Reference-counted body scroll lock. Several full-screen overlays (nav drawer,
// search) may request a lock; the page only unlocks once the LAST one releases.
// This avoids one overlay clearing the lock while another is still open, and
// preserves whatever overflow the body had before the first lock.
let lockCount = 0;
let previousOverflow = "";

function acquireLock(): void {
  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;
}

function releaseLock(): void {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = previousOverflow;
  }
}

// Lock background scroll while `active` is true. Each active consumer adds one
// reference; the body is restored only when every consumer has released.
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    acquireLock();
    return releaseLock;
  }, [active]);
}

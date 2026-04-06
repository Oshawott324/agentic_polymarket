"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function AutoRefresh({ intervalMs = 15000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      router.refresh();
    }, intervalMs);

    return () => {
      clearInterval(interval);
    };
  }, [intervalMs, router]);

  return null;
}

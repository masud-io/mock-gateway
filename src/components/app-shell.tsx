"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { CommandPalette } from "./command-palette";
import { Sidebar } from "./sidebar";

/** Sidebar + page, except on the login page, which stands alone (and must not fetch anything that needs a session). */
export function AppShell({ children }: { children: ReactNode }) {
  if (usePathname() === "/login") return <main className="h-full overflow-y-auto">{children}</main>;
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      <CommandPalette />
    </div>
  );
}

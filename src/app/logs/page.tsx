"use client";

import { LogTable } from "@/components/log-table";

export default function LogsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-bold">Request log</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Every request that reaches a mock, across all projects. Click a row to see what matched and why.</p>
      </header>
      <LogTable limit={100} />
    </div>
  );
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type LogDetail, type LogRow } from "@/lib/api";
import { useMutate } from "./providers";
import { Badge, Button, CopyButton, Empty, Input, Select, StatusBadge, MethodBadge, useOrigin } from "./ui";

const pretty = (s: string | null) => {
  if (!s) return "";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

function curl(l: LogDetail, origin: string): string {
  const parts = [`curl -X ${l.method} '${origin}${l.path}'`];
  for (const [k, v] of Object.entries(l.requestHeaders)) {
    if (!["host", "content-length", "connection"].includes(k.toLowerCase())) parts.push(`-H '${k}: ${v}'`);
  }
  if (l.requestBody) parts.push(`--data '${l.requestBody.replace(/'/g, "'\\''")}'`);
  return parts.join(" \\\n  ");
}

function Detail({ id, onClose }: { id: number; onClose: () => void }) {
  const origin = useOrigin();
  const { data, error } = useQuery({ queryKey: ["log", id], queryFn: () => api<LogDetail>("GET", `/logs/${id}`) });
  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950" role="dialog" aria-label="Request details">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h3 className="text-sm font-semibold">Request #{id}</h3>
        <Button small variant="ghost" onClick={onClose} aria-label="Close details">✕</Button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        {error && <p className="text-red-600">{(error as Error).message}</p>}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <MethodBadge method={data.method} />
              <StatusBadge status={data.responseStatus} />
              <code className="break-all font-mono text-xs">{data.path}</code>
              <Badge>{data.durationMs} ms</Badge>
              <Badge tone={data.matched ? "green" : "amber"}>{data.matched ? "matched" : "no match"}</Badge>
            </div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
              <p className="text-xs font-semibold text-zinc-500">Why</p>
              <p>{data.explanation}</p>
              {data.authResult && <p className="mt-1 text-xs text-zinc-500">Auth: {data.authResult}</p>}
              {data.validationErrors.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-amber-700 dark:text-amber-400">
                  {data.validationErrors.map((v, i) => <li key={i}>{v}</li>)}
                </ul>
              )}
            </div>
            <Block title="Request headers (credentials are masked)" text={Object.entries(data.requestHeaders).map(([k, v]) => `${k}: ${v}`).join("\n")} />
            <Block title="Request body" text={pretty(data.requestBody)} empty="(empty)" />
            <Block title="Response body" text={pretty(data.responseBody)} empty="(empty)" />
            <div>
              <div className="mb-1 flex items-center justify-between"><p className="text-xs font-semibold text-zinc-500">Replay</p><CopyButton text={curl(data, origin)} label="Copy as cURL" /></div>
              <p className="text-xs text-zinc-500">Masked credential headers will need their real values before replaying.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Block({ title, text, empty }: { title: string; text: string; empty?: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-zinc-500">{title}</p>
      <pre className="max-h-64 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-xs dark:bg-zinc-900">{text || empty}</pre>
    </div>
  );
}

/** Live request log. Polls every 2s; pass projectId/collectionId to scope it. */
export function LogTable({ projectId, collectionId, limit = 50 }: { projectId?: string; collectionId?: string; limit?: number }) {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const mutate = useMutate();

  const qs = new URLSearchParams({ limit: String(limit) });
  if (projectId) qs.set("projectId", projectId);
  if (collectionId) qs.set("collectionId", collectionId);
  if (status) qs.set("status", status);
  if (q.trim()) qs.set("q", q.trim());

  const { data, error } = useQuery({
    queryKey: ["logs", qs.toString()],
    queryFn: () => api<LogRow[]>("GET", `/logs?${qs}`),
    refetchInterval: paused ? false : 2000,
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by path…" className="max-w-56" aria-label="Filter by path" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36" aria-label="Filter by status">
          <option value="">All statuses</option><option value="2xx">2xx</option><option value="3xx">3xx</option><option value="4xx">4xx</option><option value="5xx">5xx</option><option value="miss">No match</option>
        </Select>
        <Button small onClick={() => setPaused((p) => !p)}>{paused ? "▶ Resume" : "⏸ Pause"}</Button>
        <Button
          small variant="danger"
          onClick={async () => {
            if (!confirm(projectId ? "Clear this project's request log?" : "Clear the entire request log?")) return;
            await mutate("DELETE", `/logs${projectId ? `?projectId=${projectId}` : ""}`, undefined, { ok: "Log cleared" });
          }}
        >Clear</Button>
        <span className="text-xs text-zinc-500">{paused ? "Paused" : "Live · refreshes every 2s"}</span>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{(error as Error).message}</p>}
      {data && data.length === 0 && <Empty>No requests yet. Call a mock URL (or use “Try it” on an endpoint) and it will show up here.</Empty>}
      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
              <tr><th className="px-3 py-2">Time</th><th>Method</th><th>Path</th><th>Status</th><th>ms</th><th>Why</th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} tabIndex={0} onClick={() => setOpen(r.id)} onKeyDown={(e) => e.key === "Enter" && setOpen(r.id)} className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900">
                  <td className="whitespace-nowrap px-3 py-1.5 text-xs text-zinc-500">{new Date(r.at).toLocaleTimeString()}</td>
                  <td><MethodBadge method={r.method} /></td>
                  <td className="max-w-xs truncate font-mono text-xs">{r.path.replace(/^\/mock\//, "")}</td>
                  <td><StatusBadge status={r.responseStatus} /></td>
                  <td className="text-xs text-zinc-500">{r.durationMs}</td>
                  <td className="max-w-sm truncate text-xs text-zinc-600 dark:text-zinc-400">{!r.matched && <Badge tone="amber" className="mr-1">no match</Badge>}{r.explanation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open !== null && <Detail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

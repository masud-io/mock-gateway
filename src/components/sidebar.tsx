"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { api, type TreeClient } from "@/lib/api";
import { OPEN_PALETTE } from "./command-palette";
import { cx, MethodBadge } from "./ui";

const link = (active: boolean) =>
  cx("block truncate rounded px-2 py-1 text-sm", active ? "bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300" : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800");

/** Keep only what matches every typed word: a client/project/API name matching keeps its whole subtree. */
function filterTree(tree: TreeClient[], q: string): TreeClient[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return tree;
  const hit = (text: string) => terms.every((t) => text.toLowerCase().includes(t));
  return tree.flatMap((c) => {
    const projects = c.projects.flatMap((p) => {
      const collections = p.collections.flatMap((col) => {
        const scope = `${c.name} ${p.name} ${col.name} ${col.protocol}`;
        const endpoints = hit(scope) ? col.endpoints : col.endpoints.filter((e) => hit(`${scope} ${e.name} ${e.method} ${e.path} ${e.operation ?? ""}`));
        return endpoints.length || hit(scope) ? [{ ...col, endpoints }] : [];
      });
      return collections.length ? [{ ...p, collections }] : [];
    });
    return projects.length ? [{ ...c, projects }] : [];
  });
}

export function Sidebar() {
  const pathname = usePathname();
  const { data: tree, error, isLoading } = useQuery({ queryKey: ["tree"], queryFn: () => api<TreeClient[]>("GET", "/tree") });
  const [q, setQ] = useState("");
  // Bumping `ver` remounts the <details>, which re-applies their `open` default (expand/collapse everything)
  const [fold, setFold] = useState<{ ver: number; open: boolean | null }>({ ver: 0, open: null });
  const data = useMemo(() => (tree ? filterTree(tree, q) : tree), [tree, q]);
  const searching = q.trim().length > 0;
  const openFor = (dflt: boolean) => (searching ? true : fold.open ?? dflt);

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <Link href="/" className="text-sm font-bold tracking-tight">Mock API Gateway</Link>
        <nav className="mt-2 flex gap-1 text-xs">
          <Link href="/" className={link(pathname === "/")}>Home</Link>
          <Link href="/logs" className={link(pathname === "/logs")}>Request log</Link>
        </nav>
      </div>
      <div className="space-y-1.5 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <input
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }}
          placeholder="Filter…" aria-label="Filter the tree"
          className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="flex items-center justify-between text-[11px] text-zinc-500">
          <span className="flex gap-2">
            <button type="button" className="hover:underline" onClick={() => setFold((f) => ({ ver: f.ver + 1, open: true }))}>Expand all</button>
            <button type="button" className="hover:underline" onClick={() => setFold((f) => ({ ver: f.ver + 1, open: false }))}>Collapse all</button>
          </span>
          <button type="button" className="rounded border border-zinc-300 px-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE))}>Search <kbd className="font-sans">Ctrl+K</kbd></button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-3 text-sm" aria-label="Clients, projects and endpoints">
        {isLoading && <p className="px-2 text-zinc-500">Loading…</p>}
        {error && <p className="px-2 text-red-600">Can&apos;t load the tree: {(error as Error).message}</p>}
        {data?.length === 0 && <p className="px-2 text-zinc-500">{searching ? `Nothing matches “${q.trim()}”.` : "No clients yet. Create one on the Home page."}</p>}
        {data?.map((c) => (
          <details key={`${c.id}-${fold.ver}`} open={openFor(true)} className="mb-2">
            <summary className="cursor-pointer select-none px-2 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{c.name}</summary>
            {c.projects.map((p) => (
              <details key={`${p.id}-${fold.ver}`} open={openFor(true)} className="ml-2">
                <summary className="flex cursor-pointer select-none items-center gap-1 px-2 py-1 font-medium">
                  <Link href={`/projects/${p.id}`} className={cx("truncate", pathname === `/projects/${p.id}` && "text-indigo-600")}>{p.name}</Link>
                  {p.outage && <span title="Outage simulation is ON" className="rounded bg-red-100 px-1 text-[10px] font-bold text-red-700">OUTAGE</span>}
                </summary>
                {p.collections.map((col) => {
                  const hasActive = pathname === `/collections/${col.id}` || col.endpoints.some((e) => pathname === `/endpoints/${e.id}`);
                  return (
                    <details key={`${col.id}-${fold.ver}`} open={openFor(hasActive)} className="ml-3">
                      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2 py-1">
                        <Link href={`/collections/${col.id}`} className={cx("truncate", pathname === `/collections/${col.id}` && "font-medium text-indigo-600")}>{col.name}</Link>
                        <span className="rounded bg-zinc-200 px-1 text-[10px] font-semibold uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{col.protocol}</span>
                      </summary>
                      <ul className="ml-3">
                        {col.endpoints.map((e) => (
                          <li key={e.id}>
                            <Link href={`/endpoints/${e.id}`} className={cx(link(pathname === `/endpoints/${e.id}`), "flex items-center gap-1.5", !e.enabled && "opacity-50")}>
                              {col.protocol === "soap" ? <span className="rounded bg-sky-100 px-1 text-[10px] font-semibold text-sky-700 dark:bg-sky-950 dark:text-sky-300">OP</span> : <MethodBadge method={e.method} />}
                              <span className="truncate font-mono text-xs">{col.protocol === "soap" ? e.operation ?? e.name : e.path}</span>
                            </Link>
                          </li>
                        ))}
                        {col.endpoints.length === 0 && <li className="px-2 py-1 text-xs text-zinc-500">No endpoints</li>}
                      </ul>
                    </details>
                  );
                })}
                {p.collections.length === 0 && <p className="ml-5 px-2 py-1 text-xs text-zinc-500">No collections</p>}
              </details>
            ))}
            {c.projects.length === 0 && <p className="ml-4 px-2 py-1 text-xs text-zinc-500">No projects</p>}
          </details>
        ))}
      </div>
    </aside>
  );
}

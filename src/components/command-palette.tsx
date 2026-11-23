"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TreeClient } from "@/lib/api";
import { confirmLeave } from "./providers";
import { cx } from "./ui";

type Item = { label: string; detail: string; kind: string; href: string; haystack: string };

export const OPEN_PALETTE = "open-palette";

function flatten(tree: TreeClient[]): Item[] {
  const items: Item[] = [
    { label: "Home", detail: "", kind: "page", href: "/", haystack: "home" },
    { label: "Request log", detail: "", kind: "page", href: "/logs", haystack: "request log logs" },
  ];
  for (const c of tree) for (const p of c.projects) {
    items.push({ label: p.name, detail: c.name, kind: "project", href: `/projects/${p.id}`, haystack: `${c.name} ${p.name}`.toLowerCase() });
    for (const col of p.collections) {
      items.push({ label: col.name, detail: `${c.name} / ${p.name}`, kind: col.protocol, href: `/collections/${col.id}`, haystack: `${c.name} ${p.name} ${col.name} ${col.protocol}`.toLowerCase() });
      for (const e of col.endpoints) {
        const soap = col.protocol === "soap";
        const name = soap ? e.operation ?? e.name : `${e.method === "*" ? "ANY" : e.method} ${e.path}`;
        items.push({ label: name, detail: `${p.name} / ${col.name}`, kind: soap ? "op" : "endpoint", href: `/endpoints/${e.id}`, haystack: `${c.name} ${p.name} ${col.name} ${e.name} ${e.method} ${e.path} ${e.operation ?? ""}`.toLowerCase() });
      }
    }
  }
  return items;
}

/** Ctrl/⌘+K: jump to any client's project, API or endpoint by typing a few words. */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { data } = useQuery({ queryKey: ["tree"], queryFn: () => api<TreeClient[]>("GET", "/tree"), enabled: open });

  useEffect(() => {
    const show = () => { setQ(""); setSel(0); setOpen(true); };
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (open) setOpen(false); else show(); }
    };
    window.addEventListener("keydown", key);
    window.addEventListener(OPEN_PALETTE, show);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener(OPEN_PALETTE, show); };
  }, [open]);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const results = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return flatten(data ?? []).filter((i) => terms.every((t) => i.haystack.includes(t))).slice(0, 50);
  }, [data, q]);

  if (!open) return null;
  const go = (i?: Item) => { if (!i) return; if (!confirmLeave()) return; setOpen(false); router.push(i.href); };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[15vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div role="dialog" aria-label="Quick search" className="w-full max-w-xl overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <input
          ref={input} value={q} placeholder="Jump to a project, API or endpoint…" aria-label="Search"
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter") go(results[sel]);
          }}
          className="w-full border-b border-zinc-200 bg-transparent px-4 py-3 text-sm outline-none dark:border-zinc-700"
        />
        <ul role="listbox" className="max-h-80 overflow-y-auto py-1">
          {results.map((r, i) => (
            <li key={r.href} role="option" aria-selected={i === sel} ref={(el) => { if (el && i === sel) el.scrollIntoView({ block: "nearest" }); }}
              onMouseEnter={() => setSel(i)} onClick={() => go(r)}
              className={cx("flex cursor-pointer items-center gap-2 px-4 py-1.5 text-sm", i === sel && "bg-indigo-50 dark:bg-indigo-950")}>
              <span className="w-16 shrink-0 rounded bg-zinc-100 px-1 text-center text-[10px] font-semibold uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{r.kind}</span>
              <span className="truncate font-mono text-xs">{r.label}</span>
              <span className="ml-auto truncate text-xs text-zinc-500">{r.detail}</span>
            </li>
          ))}
          {results.length === 0 && <li className="px-4 py-3 text-sm text-zinc-500">{data ? "Nothing matches." : "Loading…"}</li>}
        </ul>
        <p className="border-t border-zinc-200 px-4 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-700">↑↓ to move · Enter to open · Esc to close</p>
      </div>
    </div>
  );
}

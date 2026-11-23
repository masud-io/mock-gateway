"use client";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api";

// ---------- unsaved-changes guard ----------
const dirtyForms = new Set<string>();

/** Register a form as having unsaved edits while `dirty` is true; leaving the page then asks first. */
export function useUnsavedGuard(dirty: boolean) {
  const id = useId();
  useEffect(() => {
    if (dirty) dirtyForms.add(id);
    else dirtyForms.delete(id);
    return () => { dirtyForms.delete(id); };
  }, [dirty, id]);
}

/** For programmatic navigation: true when nothing is unsaved, or the user agrees to discard it. */
export function confirmLeave() {
  return !dirtyForms.size || confirm("You have unsaved changes. Leave this page and discard them?");
}

/** Asks before closing the tab or following an in-app link while any form has unsaved edits. */
function NavigationGuard() {
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => { if (dirtyForms.size) e.preventDefault(); };
    const onClick = (e: MouseEvent) => {
      if (!dirtyForms.size || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.origin !== location.origin) return;
      if (a.pathname === location.pathname && a.search === location.search) return;
      if (!confirm("You have unsaved changes. Leave this page and discard them?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
  return null;
}

type Toast = { id: number; text: string; kind: "ok" | "error" };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 0, refetchOnWindowFocus: true, retry: false } } }));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 2500);
  }, []);
  return (
    <QueryClientProvider client={qc}>
      <ToastCtx.Provider value={notify}>
        {children}
        <NavigationGuard />
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className={`pointer-events-auto rounded-md px-3 py-2 text-sm shadow-lg ${t.kind === "error" ? "bg-red-600 text-white" : "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"}`}>
              {t.text}
            </div>
          ))}
        </div>
      </ToastCtx.Provider>
    </QueryClientProvider>
  );
}

/**
 * Run an admin write. Shows the server's error as a toast (and returns it so a form can also show it inline),
 * and refreshes every query on success: simple and correct for a local single-user tool.
 */
export function useMutate() {
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    async <T = unknown,>(method: string, path: string, body?: unknown, opts: { ok?: string; silentError?: boolean } = {}): Promise<{ data?: T; error?: string }> => {
      try {
        const data = await api<T>(method, path, body);
        await qc.invalidateQueries();
        if (opts.ok) toast(opts.ok);
        return { data };
      } catch (e) {
        const error = e instanceof ApiError ? e.message : "Network error: is the gateway running?";
        if (!opts.silentError) toast(error, "error");
        return { error };
      }
    },
    [qc, toast],
  );
}

"use client";

import { useState, useSyncExternalStore, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { Matcher } from "@/lib/api";

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");

const field =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx(field, className)} />;
}
export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx(field, className)} />;
}
export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea spellCheck={false} {...p} className={cx(field, "resize-y font-mono text-[13px] leading-5", className)} />;
}

const variants = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-500 disabled:hover:bg-indigo-600",
  secondary: "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
  danger: "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
  ghost: "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
};
export function Button({ variant = "secondary", small, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants; small?: boolean }) {
  return (
    <button
      type="button"
      {...p}
      className={cx("inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50", small ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm", variants[variant], className)}
    />
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const tones = {
  gray: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  indigo: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
};
export function Badge({ tone = "gray", children, className }: { tone?: keyof typeof tones; children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold leading-4", tones[tone], className)}>{children}</span>;
}

const methodTone: Record<string, keyof typeof tones> = { GET: "green", POST: "blue", PUT: "amber", PATCH: "amber", DELETE: "red" };
export const MethodBadge = ({ method }: { method: string }) => (
  <Badge tone={methodTone[method.toUpperCase()] ?? "gray"} className="w-14 justify-center font-mono">{method === "*" ? "ANY" : method}</Badge>
);

export const statusTone = (s: number): keyof typeof tones => (s >= 500 ? "red" : s >= 400 ? "amber" : s >= 300 ? "blue" : "green");
export const StatusBadge = ({ status }: { status: number }) => <Badge tone={statusTone(status)} className="font-mono">{status}</Badge>;

export const ErrorText = ({ children }: { children?: ReactNode }) =>
  children ? <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{children}</p> : null;

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">{children}</p>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      small
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked: nothing useful to do */
        }
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

/** Absolute origin for display ("http://127.0.0.1:3000"); empty during SSR to avoid hydration mismatch. */
export function useOrigin() {
  return useSyncExternalStore(
    () => () => {}, // the origin never changes while the page is open
    () => window.location.origin,
    () => "",
  );
}

/** Copy of an object without one key. */
export function omitKey<T extends Record<string, unknown>>(obj: T, key: string): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)) as Partial<T>;
}

export function MockUrl({ path }: { path: string }) {
  const origin = useOrigin();
  const full = `${origin}${path}`;
  return (
    <div className="flex items-center gap-2">
      <code className="truncate rounded bg-zinc-100 px-2 py-1 font-mono text-xs dark:bg-zinc-800">{full}</code>
      <CopyButton text={full} />
    </div>
  );
}

// ---------- editors ----------
export function KeyValueEditor({ value, onChange, keyPlaceholder = "Header", valuePlaceholder = "Value" }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; keyPlaceholder?: string; valuePlaceholder?: string }) {
  // Rows are kept as an array so a half-typed duplicate/empty key doesn't collapse while editing
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value));
  const emit = (r: [string, string][]) => {
    setRows(r);
    onChange(Object.fromEntries(r.filter(([k]) => k.trim())));
  };
  return (
    <div className="space-y-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5">
          <Input value={k} placeholder={keyPlaceholder} onChange={(e) => emit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} className="w-2/5 font-mono" />
          <Input value={v} placeholder={valuePlaceholder} onChange={(e) => emit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} className="font-mono" />
          <Button small variant="ghost" aria-label="Remove row" onClick={() => emit(rows.filter((_, j) => j !== i))}>✕</Button>
        </div>
      ))}
      <Button small onClick={() => emit([...rows, ["", ""]])}>+ Add</Button>
    </div>
  );
}

const SOURCE_HINT: Record<Matcher["source"], string> = { header: "Header name", query: "Query param", path: "Path param", body: "JSONPath, e.g. $.user.id" };
export function MatcherEditor({ value, onChange }: { value: Matcher[]; onChange: (v: Matcher[]) => void }) {
  const set = (i: number, patch: Partial<Matcher>) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <div className="space-y-1.5">
      {value.length === 0 && <p className="text-xs text-zinc-500">No conditions: always matches.</p>}
      {value.map((m, i) => (
        <div key={i} className="flex flex-wrap gap-1.5">
          <Select value={m.source} onChange={(e) => set(i, { source: e.target.value as Matcher["source"] })} className="w-24">
            <option value="header">header</option><option value="query">query</option><option value="path">path</option><option value="body">body</option>
          </Select>
          <Input value={m.expr} placeholder={SOURCE_HINT[m.source]} onChange={(e) => set(i, { expr: e.target.value })} className="min-w-40 flex-1 font-mono" />
          <Select value={m.op} onChange={(e) => set(i, { op: e.target.value as Matcher["op"] })} className="w-36">
            <option value="equals">equals</option><option value="not_equals">does not equal</option><option value="contains">contains</option><option value="regex">matches regex</option><option value="exists">exists</option><option value="not_exists">does not exist</option>
          </Select>
          {m.op !== "exists" && m.op !== "not_exists" && <Input value={m.value ?? ""} placeholder="value" onChange={(e) => set(i, { value: e.target.value })} className="min-w-32 flex-1 font-mono" />}
          <Button small variant="ghost" aria-label="Remove condition" onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</Button>
        </div>
      ))}
      <Button small onClick={() => onChange([...value, { source: "header", expr: "", op: "equals", value: "" }])}>+ Condition</Button>
    </div>
  );
}

/** Textarea holding JSON; reports parse errors inline and only emits valid values. */
export function JsonField({ value, onChange, rows = 8, placeholder }: { value: unknown; onChange: (v: unknown | null) => void; rows?: number; placeholder?: string }) {
  const [text, setText] = useState(() => (value == null ? "" : JSON.stringify(value, null, 2)));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <Textarea
        rows={rows}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (!t.trim()) {
            setErr(null);
            onChange(null);
            return;
          }
          try {
            onChange(JSON.parse(t));
            setErr(null);
          } catch (x) {
            setErr(x instanceof Error ? x.message : "Invalid JSON");
          }
        }}
      />
      {err && <p className="mt-1 text-xs text-red-600">Invalid JSON: {err}</p>}
    </div>
  );
}

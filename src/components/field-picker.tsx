"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Matcher } from "@/lib/api";
import { Badge, Button, ErrorText, Textarea } from "./ui";

interface Field {
  source: "body" | "header" | "query";
  expr: string;
  value: string;
}

const storage = (key: string) => `mockgw.sample.${key}`;
const load = (key: string) => {
  try { return localStorage.getItem(storage(key)) ?? ""; } catch { return ""; }
};
const save = (key: string, v: string) => {
  try { localStorage.setItem(storage(key), v); } catch { /* storage unavailable: the sample just isn't remembered */ }
};

/**
 * "Build a condition from a sample request": paste a request once, then add a condition on any of its fields with one click.
 * The expressions come from the server, which reads the sample the same way the mock reads a real request.
 * The sample is remembered per endpoint in this browser.
 */
export function FieldPicker({ protocol, storageKey, onPick }: { protocol: "rest" | "soap"; storageKey: string; onPick: (m: Matcher) => void }) {
  const [text, setText] = useState(() => load(storageKey));
  const [fields, setFields] = useState<Field[] | null>(null);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<string>();
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const read = async (sample: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<{ fields: Field[]; summary: string }>("POST", "/request-fields", { text: sample, protocol });
      setFields(r.fields);
      setSummary(r.summary);
      save(storageKey, sample);
    } catch (e) {
      setFields(null);
      setError(e instanceof ApiError ? e.message : "Could not read that request");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  const pick = (f: Field, op: "equals" | "not_equals") => {
    onPick({ source: f.source, expr: f.expr, op, value: f.value });
    setAdded(`${op}:${f.source}:${f.expr}`);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAdded(undefined), 1500);
  };

  return (
    <details
      className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
      // A remembered sample is read when the panel is opened, so its fields are there straight away
      onToggle={(e) => { if (e.currentTarget.open && !fields && !busy && text.trim()) void read(text); }}
    >
      <summary className="cursor-pointer text-xs font-semibold text-zinc-600 dark:text-zinc-400">Build a condition from a sample request</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-zinc-500">
          Paste a request {protocol === "soap" ? "(the XML inside the Body, or the whole envelope)" : "(JSON body)"} or a cURL command. Each field it contains can then be added as a condition with one click; edit the value in the condition afterwards.
        </p>
        <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} aria-label="Sample request"
          placeholder={protocol === "soap" ? "<P2PAccountCreditCreateRequest>\n  <InputParameter>…</InputParameter>\n</P2PAccountCreditCreateRequest>" : '{ "amount": 1200, "currency": "USD" }'} />
        <div className="flex items-center gap-2">
          <Button small variant="primary" disabled={!text.trim() || busy} onClick={() => read(text)}>{busy ? "Reading…" : "Read fields"}</Button>
          {fields && <span className="text-xs text-zinc-500">{summary} · {fields.length} field{fields.length === 1 ? "" : "s"}</span>}
        </div>
        <ErrorText>{error}</ErrorText>
        {fields && (
          <ul className="max-h-72 divide-y divide-zinc-200 overflow-auto rounded-md border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
            {fields.map((f) => {
              const id = `${f.source}:${f.expr}`;
              return (
                <li key={id} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                  <Badge>{f.source}</Badge>
                  <code className="min-w-0 flex-1 break-all font-mono text-xs" title={f.expr}>{f.expr}</code>
                  <code className="max-w-56 truncate rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800" title={f.value}>{f.value === "" ? "(empty)" : f.value}</code>
                  <Button small onClick={() => pick(f, "equals")} title="Add: this field equals this value">{added === `equals:${id}` ? "Added ✓" : "= value"}</Button>
                  <Button small onClick={() => pick(f, "not_equals")} title="Add: this field does not equal this value">{added === `not_equals:${id}` ? "Added ✓" : "≠ value"}</Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}

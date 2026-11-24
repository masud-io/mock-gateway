"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { CodeEditor } from "@/components/code-editor";
import { useMutate, useUnsavedGuard } from "@/components/providers";
import { Badge, Button, Card, CopyButton, Empty, ErrorText, Field, Input, KeyValueEditor, MethodBadge, Select, StatusBadge, useOrigin } from "@/components/ui";
import { api, ApiError, type CollectionDetail, type SavedRequest, type SendResult } from "@/lib/api";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const editable = (r: SavedRequest) => ({ name: r.name, folder: r.folder ?? "", method: r.method, path: r.path, headers: r.headers, body: r.body });
type Draft = ReturnType<typeof editable>;

const pretty = (s: string) => {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
};

type Outcome = { result: SendResult } | { error: string };

export default function RequestsPage() {
  const { id } = useParams<{ id: string }>();
  const mutate = useMutate();
  const collection = useQuery({ queryKey: ["collection", id], queryFn: () => api<CollectionDetail>("GET", `/collections/${id}`) });
  const requests = useQuery({ queryKey: ["requests", id], queryFn: () => api<SavedRequest[]>("GET", `/collections/${id}/requests`) });
  const [selected, setSelected] = useState<string | null>(null);
  // The last answer for each request, kept while you switch between them
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  if (collection.error) return <div className="p-6"><ErrorText>{(collection.error as Error).message}</ErrorText></div>;
  if (!collection.data || !requests.data) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;
  const { collection: col, client, project } = collection.data;
  const list = requests.data;
  const current = list.find((r) => r.id === selected) ?? null;

  // Grouped by folder, in the order the server sorts them (named folders first, then "No folder")
  const groups: { folder: string | null; items: SavedRequest[] }[] = [];
  for (const r of list) {
    const g = groups.find((x) => x.folder === r.folder);
    if (g) g.items.push(r);
    else groups.push({ folder: r.folder, items: [r] });
  }

  const add = async () => {
    const r = await mutate<SavedRequest>("POST", `/collections/${id}/requests`, { folder: current?.folder ?? null, path: "/" }, { ok: "Request added" });
    if (r.data) setSelected(r.data.id);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="space-y-1">
        <p className="text-xs text-zinc-500">{client.name} / <Link href={`/projects/${project.id}`} className="hover:underline">{project.name}</Link> / <Link href={`/collections/${id}`} className="hover:underline">{col.name}</Link></p>
        <h1 className="text-xl font-bold">Requests</h1>
        <p className="text-sm text-zinc-500">
          Save the requests you test with, and send them to this API&apos;s mock in one click. Use <code>{"{{vars.name}}"}</code> for variables (this API&apos;s, then the project&apos;s, then the client&apos;s) and the template helpers such as <code>{"{{randomDigits 12}}"}</code> or <code>{"{{uuid}}"}</code>.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card title="Saved" actions={<Button small variant="primary" onClick={add}>+ New</Button>}>
          {list.length === 0 ? (
            <Empty>No saved requests yet. Add one, or use “Save as request” in Try it on an endpoint.</Empty>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <div key={g.folder ?? "∅"}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{g.folder ?? "No folder"}</p>
                  <ul className="space-y-0.5">
                    {g.items.map((r) => (
                      <li key={r.id}>
                        <button type="button" onClick={() => setSelected(r.id)} aria-current={r.id === selected}
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 ${r.id === selected ? "bg-indigo-50 font-medium dark:bg-indigo-950" : ""}`}>
                          <MethodBadge method={r.method} /><span className="min-w-0 flex-1 truncate">{r.name}</span>
                          {outcomes[r.id] && ("result" in outcomes[r.id] ? <StatusBadge status={(outcomes[r.id] as { result: SendResult }).result.status} /> : <Badge tone="red">error</Badge>)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>

        {current ? (
          <Editor key={current.id} request={current} folders={[...new Set(list.map((r) => r.folder).filter((f): f is string => !!f))]}
            protocol={col.protocol} mockBase={collection.data.mockBase} collectionId={id} outcome={outcomes[current.id]}
            onOutcome={(o) => setOutcomes((x) => ({ ...x, [current.id]: o }))} onDeleted={() => setSelected(null)} onCopied={(n) => setSelected(n)} />
        ) : (
          <Card><Empty>{list.length ? "Pick a request on the left." : "Nothing to send yet."}</Empty></Card>
        )}
      </div>
    </div>
  );
}

function Editor({ request, folders, protocol, mockBase, collectionId, outcome, onOutcome, onDeleted, onCopied }: {
  request: SavedRequest; folders: string[]; protocol: "rest" | "soap"; mockBase: string; collectionId: string; outcome?: Outcome;
  onOutcome: (o: Outcome) => void; onDeleted: () => void; onCopied: (id: string) => void;
}) {
  const mutate = useMutate();
  const origin = useOrigin();
  const [d, setD] = useState<Draft>(() => editable(request));
  const [seen, setSeen] = useState(request.updatedAt);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [resets, setResets] = useState(0); // the header editor reads its value once, so remount it when the draft is reset
  if (seen !== request.updatedAt) {
    // A save came back from the server: re-seed the draft from it
    setSeen(request.updatedAt);
    setD(editable(request));
    setResets((n) => n + 1);
  }
  const dirty = JSON.stringify(d) !== JSON.stringify(editable(request));
  useUnsavedGuard(dirty);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const save = async () => {
    const r = await mutate("PATCH", `/requests/${request.id}`, { ...d, folder: d.folder.trim() || null }, { ok: "Request saved", silentError: true });
    setError(r.error);
  };
  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onOutcome({ result: await api<SendResult>("POST", `/collections/${collectionId}/send`, { method: d.method, path: d.path, headers: d.headers, body: d.body }) });
    } catch (e) {
      onOutcome({ error: e instanceof ApiError ? e.message : "Network error: is the gateway running?" });
    } finally {
      setBusy(false);
    }
  };
  const noBody = d.method === "GET" || d.method === "HEAD";

  return (
    <div className="min-w-0 space-y-4"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) void save(); }
        else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!busy) void send(); }
      }}>
      <Card title={<>Request {dirty && <Badge tone="amber">unsaved</Badge>}</>} actions={
        <>
          <Button small onClick={async () => { const r = await mutate<SavedRequest>("POST", `/requests/${request.id}/duplicate`, undefined, { ok: "Request duplicated" }); if (r.data) onCopied(r.data.id); }}>Duplicate</Button>
          <Button small variant="danger" onClick={async () => { if (!confirm(`Delete "${request.name}"?`)) return; const r = await mutate("DELETE", `/requests/${request.id}`, undefined, { ok: "Request deleted" }); if (!r.error) onDeleted(); }}>Delete</Button>
        </>
      }>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={d.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <Field label="Folder (optional)">
              <Input list="request-folders" value={d.folder} onChange={(e) => set("folder", e.target.value)} placeholder="e.g. Auth" />
              <datalist id="request-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
            </Field>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <Field label="Method"><Select value={d.method} onChange={(e) => set("method", e.target.value)} className="w-28">{METHODS.map((m) => <option key={m}>{m}</option>)}</Select></Field>
            <Field label="Path" className="min-w-60 flex-1" hint={<span className="break-all">{origin}{mockBase}{d.path.startsWith("/") || d.path === "" || d.path.startsWith("?") ? d.path : `/${d.path}`}</span>}>
              <Input value={d.path} onChange={(e) => set("path", e.target.value)} placeholder="/getToken" className="font-mono" />
            </Field>
            <div className="pt-5"><Button variant="primary" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send"} <span className="text-[10px] opacity-70">Ctrl+Enter</span></Button></div>
          </div>
          <Field label="Headers"><KeyValueEditor key={resets} value={d.headers} onChange={(v) => set("headers", v)} /></Field>
          <Field label="Body" hint={noBody ? `${d.method} requests are sent without a body.` : protocol === "soap" ? "The full SOAP envelope. Content-Type defaults to text/xml." : "Content-Type is set to application/json for a JSON body unless you add the header."}>
            <CodeEditor label="Request body" value={d.body} onChange={(v) => set("body", v)} minRows={8} language={protocol === "soap" ? "xml" : "json"} />
          </Field>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button disabled={!dirty} onClick={() => { setD(editable(request)); setResets((n) => n + 1); }}>Discard changes</Button>
            <Button variant="primary" disabled={!dirty} onClick={save}>Save <span className="text-[10px] opacity-70">Ctrl+S</span></Button>
          </div>
        </div>
      </Card>

      <Card title="Response" actions={outcome && "result" in outcome ? <CopyButton text={outcome.result.body} label="Copy body" /> : undefined}>
        {!outcome ? (
          <p className="text-sm text-zinc-500">Press Send to see the mock&apos;s answer here.</p>
        ) : "error" in outcome ? (
          <p role="alert" className="text-sm text-red-600">{outcome.error}</p>
        ) : (
          <div className="space-y-2" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={outcome.result.status} />
              <span className="text-xs text-zinc-500">{outcome.result.ms} ms · {new Blob([outcome.result.body]).size} bytes</span>
              <code className="break-all text-xs text-zinc-500">{outcome.result.sent.method} {outcome.result.sent.url}</code>
            </div>
            <pre className="max-h-96 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-xs dark:bg-zinc-900">{outcome.result.body ? pretty(outcome.result.body) : "(empty body)"}</pre>
            <details><summary className="cursor-pointer text-xs text-zinc-500">Response headers</summary>
              <pre className="mt-1 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-xs dark:bg-zinc-900">{outcome.result.headers.map(([k, v]) => `${k}: ${v}`).join("\n")}</pre></details>
            <details><summary className="cursor-pointer text-xs text-zinc-500">What was sent (variables filled in)</summary>
              <pre className="mt-1 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-xs dark:bg-zinc-900">{[`${outcome.result.sent.method} ${outcome.result.sent.url}`, ...Object.entries(outcome.result.sent.headers).map(([k, v]) => `${k}: ${v}`), "", outcome.result.sent.body].join("\n")}</pre></details>
          </div>
        )}
      </Card>
    </div>
  );
}

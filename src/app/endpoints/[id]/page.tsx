"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { RuleCard, type RulePosition } from "@/components/rule-card";
import { useMutate, useUnsavedGuard } from "@/components/providers";
import { TryIt } from "@/components/try-it";
import { Badge, Button, Card, Empty, ErrorText, Field, Input, JsonField, MatcherEditor, MockUrl, Select } from "@/components/ui";
import { api, type EndpointDetail, type Matcher, type Rule } from "@/lib/api";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"];

export default function EndpointPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const mutate = useMutate();
  const { data, error } = useQuery({ queryKey: ["endpoint", id], queryFn: () => api<EndpointDetail>("GET", `/endpoints/${id}`) });

  if (error) return <div className="p-6"><ErrorText>{(error as Error).message}</ErrorText></div>;
  if (!data) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;
  const { endpoint, collection, project, client, rules, scenarios } = data;
  const sampleParams = Object.fromEntries([...endpoint.path.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => [m[1], "1"]));
  const soap = collection.protocol === "soap";
  const hasDefault = rules.some((r) => r.isDefault && (r.scenarioId === null));

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-xs text-zinc-500">
          {client.name} / <Link href={`/projects/${project.id}`} className="hover:underline">{project.name}</Link> / <Link href={`/collections/${collection.id}`} className="hover:underline">{collection.name}</Link>
        </p>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold">{soap ? endpoint.operation : endpoint.name} {!endpoint.enabled && <Badge>disabled</Badge>}</h1>
          <div className="flex gap-2">
            <Button small onClick={async () => { const r = await mutate<{ id: string }>("POST", `/endpoints/${id}/duplicate`, undefined, { ok: "Endpoint duplicated" }); if (r.data) router.push(`/endpoints/${r.data.id}`); }}>Duplicate</Button>
            <Button small variant="danger" onClick={async () => { if (!confirm(`Delete endpoint "${endpoint.name}"?`)) return; const r = await mutate("DELETE", `/endpoints/${id}`, undefined, { ok: "Endpoint deleted" }); if (!r.error) router.push(`/collections/${collection.id}`); }}>Delete</Button>
          </div>
        </div>
        <MockUrl path={soap && endpoint.path === "/" ? data.mockBase : `${data.mockBase}${endpoint.path}`} />
        {soap && <p className="text-xs text-zinc-500">POST a SOAP envelope to this URL. The first element inside the Body (<code>{endpoint.operation}</code>) selects this endpoint; the path is not checked.</p>}
      </header>

      <RequestSection key={endpoint.updatedAt} data={data} />

      <Card
        title="Responses"
        actions={<Button small variant="primary" onClick={() => mutate("POST", `/endpoints/${id}/rules`, { name: "New rule", ...(soap ? { contentType: "text/xml", body: `<${endpoint.operation}Response/>` } : { body: "{}" }) }, { ok: "Rule added" })}>+ Add rule</Button>}
      >
        {rules.length === 0 ? (
          <Empty>No response rules. Add one so this endpoint can answer.</Empty>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-zinc-500">Numbered in the order they are checked: scenario-specific rules first, then the rest. The first rule whose conditions all match answers; otherwise the default rule does. Drag ⠿ (or use ▲▼) to reorder.</p>
            <RuleList endpointId={id} rules={rules} scenarios={scenarios} sampleParams={sampleParams} soapOperation={soap ? endpoint.operation ?? "" : undefined} />
            {!hasDefault && <p className="text-xs text-amber-700 dark:text-amber-400">There&apos;s no default rule that applies in every scenario. Requests that match no rule will get a 501.</p>}
          </div>
        )}
      </Card>

      <TryIt key={id} collectionId={collection.id} mockBase={data.mockBase} method={endpoint.method} path={endpoint.path} soap={soap ? { operation: endpoint.operation ?? "", soapAction: endpoint.soapAction ?? "" } : undefined} />
    </div>
  );
}

function RequestSection({ data }: { data: EndpointDetail }) {
  const { endpoint } = data;
  const mutate = useMutate();
  const [name, setName] = useState(endpoint.name);
  const [method, setMethod] = useState(endpoint.method);
  const [path, setPath] = useState(endpoint.path);
  const soap = data.collection.protocol === "soap";
  const [operation, setOperation] = useState(endpoint.operation ?? "");
  const [soapAction, setSoapAction] = useState(endpoint.soapAction ?? "");
  const [enabled, setEnabled] = useState(endpoint.enabled);
  const [matchers, setMatchers] = useState<Matcher[]>(endpoint.matchers as Matcher[]);
  const [schema, setSchema] = useState<unknown>(endpoint.requestSchema ?? null);
  const [error, setError] = useState<string>();
  const current = soap ? { name: name.trim(), path: path.trim() || "/", operation: operation.trim(), soapAction: soapAction.trim() || null, enabled, matchers } : { name: name.trim(), method, path, enabled, matchers, requestSchema: schema };
  const stored = soap ? { name: endpoint.name, path: endpoint.path, operation: (endpoint.operation ?? "").trim(), soapAction: endpoint.soapAction?.trim() || null, enabled: endpoint.enabled, matchers: endpoint.matchers } : { name: endpoint.name, method: endpoint.method, path: endpoint.path, enabled: endpoint.enabled, matchers: endpoint.matchers, requestSchema: endpoint.requestSchema ?? null };
  const dirty = JSON.stringify(current) !== JSON.stringify(stored);
  useUnsavedGuard(dirty);
  const save = async () => { const r = await mutate("PATCH", `/endpoints/${endpoint.id}`, current, { ok: "Endpoint saved — live now", silentError: true }); setError(r.error); };

  return (
    <div onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) void save(); } }}>
    <Card title={<>Request {dirty && <Badge tone="amber">unsaved</Badge>}</>}>
      {soap ? (
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Path" hint="The provider's own path, e.g. /getToken. Only used for the URL you copy: requests are matched by operation."><Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/getToken" className="font-mono" /></Field>
          <Field label="Operation" hint="First element inside the SOAP Body"><Input value={operation} onChange={(e) => setOperation(e.target.value)} className="font-mono" /></Field>
          <Field label="SOAPAction" hint="Recorded as documented; a different value from the client is noted in the log, not rejected."><Input value={soapAction} onChange={(e) => setSoapAction(e.target.value)} className="font-mono" /></Field>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_2fr]">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m} value={m}>{m === "*" ? "ANY" : m}</option>)}</Select></Field>
          <Field label="Path" hint="/orders/:id captures id. A trailing * captures the rest."><Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" /></Field>
        </div>
      )}
      <div className="mt-4 space-y-4">
        <Field label="Only match requests where ALL of these hold" hint={soap ? "Use this to give two endpoints the same operation but different behaviour (for example by a field in the Body)." : "Use this to give two endpoints the same method and path but different behaviour (for example by a header)."}>
          <MatcherEditor value={matchers} onChange={setMatchers} />
        </Field>
        {!soap && (
          <Field label="Request body JSON Schema (optional)" hint="When the API's validation is strict, requests that don't fit are rejected with the collection's error response.">
            <JsonField value={schema} onChange={setSchema} rows={8} placeholder='{ "type": "object", "required": ["amount"], "properties": { "amount": { "type": "number" } } }' />
          </Field>
        )}
        {soap && <p className="text-xs text-zinc-500">Conditions read the parsed Body, e.g. a body condition <code>$.GetOrder.OrderId</code> equals <code>7</code>. XSD validation of requests isn&apos;t supported: malformed XML and unknown operations are answered with a Fault.</p>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" disabled={!dirty} onClick={save}>Save request settings <span className="text-[10px] opacity-70">Ctrl+S</span></Button>
      </div>
      <div className="mt-2"><ErrorText>{error}</ErrorText></div>
    </Card>
    </div>
  );
}

/** Rules in the order the engine checks them (mirrors core/engine.ts): scenario rules, then any-scenario rules, default last. */
function evaluationOrder(rules: Rule[]): Rule[] {
  const by = (a: Rule, b: Rule) => (a.scenarioId === null ? 1 : 0) - (b.scenarioId === null ? 1 : 0) || a.priority - b.priority;
  return [...rules.filter((r) => !r.isDefault).sort(by), ...rules.filter((r) => r.isDefault).sort(by)];
}

function RuleList({ endpointId, rules, scenarios, sampleParams, soapOperation }: { endpointId: string; rules: Rule[]; scenarios: EndpointDetail["scenarios"]; sampleParams: Record<string, string>; soapOperation?: string }) {
  const mutate = useMutate();
  const ordered = evaluationOrder(rules);
  const movable = ordered.filter((r) => !r.isDefault);
  const [armed, setArmed] = useState<string | null>(null); // the rule whose handle is pressed: only then may its card be dragged
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const reorder = (ids: string[]) => mutate("POST", `/endpoints/${endpointId}/rules/reorder`, { ids: [...ids, ...ordered.filter((r) => r.isDefault).map((r) => r.id)] }, { ok: "Order saved — live now" });
  const move = (id: string, to: number) => {
    const ids = movable.map((r) => r.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    void reorder(ids);
  };

  return (
    <>
      {ordered.map((r) => {
        const idx = movable.findIndex((m) => m.id === r.id);
        const position: RulePosition = {
          label: r.isDefault ? "∞" : String(idx + 1),
          canMoveUp: idx > 0, canMoveDown: idx >= 0 && idx < movable.length - 1,
          onMove: (dir) => move(r.id, idx + dir),
          ...(r.isDefault || movable.length < 2 ? {} : { onHandleDown: () => setArmed(r.id), onHandleUp: () => setArmed(null) }),
        };
        return (
          <div
            key={r.id}
            draggable={armed === r.id}
            onDragStart={(e) => { setDragging(r.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); }}
            onDragEnd={() => { setDragging(null); setOver(null); setArmed(null); }}
            onDragOver={(e) => { if (dragging && !r.isDefault) { e.preventDefault(); setOver(r.id); } }}
            onDrop={(e) => { e.preventDefault(); if (dragging && dragging !== r.id && !r.isDefault) move(dragging, idx); setDragging(null); setOver(null); setArmed(null); }}
            className={over === r.id && dragging !== r.id ? "rounded-md ring-2 ring-indigo-400" : dragging === r.id ? "opacity-50" : undefined}
          >
            <RuleCard rule={r} scenarios={scenarios} sampleParams={sampleParams} soapOperation={soapOperation} position={position} />
          </div>
        );
      })}
    </>
  );
}

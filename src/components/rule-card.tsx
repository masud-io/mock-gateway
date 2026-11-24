"use client";

import { useState } from "react";
import { api, ApiError, type Matcher, type Rule, type Scenario } from "@/lib/api";
import { CodeEditor } from "./code-editor";
import { useMutate, useUnsavedGuard } from "./providers";
import { Badge, Button, ErrorText, Field, Input, KeyValueEditor, MatcherEditor, Select, StatusBadge, Textarea } from "./ui";

const editable = (r: Rule) => ({
  name: r.name, scenarioId: r.scenarioId, priority: r.priority, isDefault: r.isDefault, conditions: r.conditions as Matcher[],
  status: r.status, headers: r.headers, contentType: r.contentType, body: r.body, delayMs: r.delayMs,
});
type Draft = ReturnType<typeof editable>;

const CONTENT_TYPES = ["application/json", "application/xml", "text/xml", "text/plain", "text/html"];

/**
 * One response rule. Stays mounted across saves (so it doesn't collapse under you);
 * the draft is re-seeded from the stored rule whenever the server reports a new version of it.
 */
export type RulePosition = { label: string; canMoveUp: boolean; canMoveDown: boolean; onMove: (dir: -1 | 1) => void; onHandleDown?: () => void; onHandleUp?: () => void };

export function RuleCard({ rule, scenarios, sampleParams, soapOperation, position }: { rule: Rule; scenarios: Scenario[]; sampleParams: Record<string, string>; soapOperation?: string; position?: RulePosition }) {
  const mutate = useMutate();
  const [d, setD] = useState<Draft>(() => editable(rule));
  const [error, setError] = useState<string>();
  const [seenVersion, setSeenVersion] = useState(rule.updatedAt);
  if (seenVersion !== rule.updatedAt) {
    // Adjusting state while rendering is React's recommended way to reset a draft from changed props
    setSeenVersion(rule.updatedAt);
    setD(editable(rule));
    setError(undefined);
  }
  const [open, setOpen] = useState(rule.name === "New rule");
  const [sample, setSample] = useState(() => JSON.stringify({ params: sampleParams, query: {}, headers: {}, body: soapOperation ? { [soapOperation]: {} } : {}, vars: {} }, null, 2));
  const [preview, setPreview] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty = JSON.stringify(d) !== JSON.stringify(editable(rule));
  useUnsavedGuard(dirty);
  const save = async () => { const r = await mutate("PATCH", `/rules/${rule.id}`, d, { ok: "Rule saved — live now", silentError: true }); setError(r.error); };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const scenarioName = scenarios.find((s) => s.id === rule.scenarioId)?.name;

  const runPreview = async () => {
    let request: unknown;
    try {
      request = JSON.parse(sample);
    } catch {
      return setPreview({ ok: false, text: "The sample request isn't valid JSON." });
    }
    const { params, query, headers, body, vars } = request as Record<string, unknown>;
    try {
      const r = await api<{ output: string }>("POST", "/preview", { template: d.body, request: { params, query, headers, body }, vars, scenario: scenarioName ?? null });
      let text = r.output;
      try { text = JSON.stringify(JSON.parse(r.output), null, 2); } catch { /* not JSON */ }
      setPreview({ ok: true, text });
    } catch (e) {
      setPreview({ ok: false, text: e instanceof ApiError ? e.message : "Preview failed" });
    }
  };

  return (
    <div
      className={`rounded-md border ${dirty ? "border-amber-400" : "border-zinc-200 dark:border-zinc-800"}`}
      onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) void save(); } }}
    >
      <div className="flex items-center">
        {position && (
          <div className="flex items-center gap-0.5 pl-2">
            <span
              onMouseDown={position.onHandleDown} onMouseUp={position.onHandleUp}
              className={`select-none px-1 text-zinc-400 ${position.onHandleDown ? "cursor-grab" : "opacity-30"}`} title={position.onHandleDown ? "Drag to change the order" : "The default rule always answers last"} aria-hidden
            >⠿</span>
            <Badge tone={rule.isDefault ? "indigo" : "gray"} className="min-w-5 justify-center">{position.label}</Badge>
            {position.onHandleDown && (
              <>
                <button type="button" aria-label={`Move "${rule.name}" earlier`} disabled={!position.canMoveUp} onClick={() => position.onMove(-1)} className="px-1 text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-20 dark:hover:text-zinc-100">▲</button>
                <button type="button" aria-label={`Move "${rule.name}" later`} disabled={!position.canMoveDown} onClick={() => position.onMove(1)} className="px-1 text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-20 dark:hover:text-zinc-100">▼</button>
              </>
            )}
          </div>
        )}
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left">
          <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
          <span className="truncate font-medium">{rule.name}</span>
          <StatusBadge status={rule.status} />
          {rule.isDefault && <Badge tone="indigo">default</Badge>}
          {scenarioName && <Badge tone="amber">scenario: {scenarioName}</Badge>}
          {rule.conditions.length > 0 && <Badge>{rule.conditions.length} condition{rule.conditions.length > 1 ? "s" : ""}</Badge>}
          {!rule.isDefault && rule.conditions.length === 0 && !rule.scenarioId && <Badge tone="amber">no conditions: always matches</Badge>}
          {rule.delayMs > 0 && <Badge>{rule.delayMs} ms</Badge>}
          {dirty && <Badge tone="amber">unsaved</Badge>}
        </button>
      </div>

      {open && (
        <div className="space-y-4 border-t border-zinc-200 p-3 dark:border-zinc-800">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Rule name" className="sm:col-span-2"><Input value={d.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <Field label="Status"><Input type="number" min={100} max={599} value={d.status} onChange={(e) => set("status", Number(e.target.value))} /></Field>
            <Field label="Delay (ms)"><Input type="number" min={0} max={60000} value={d.delayMs} onChange={(e) => set("delayMs", Number(e.target.value))} /></Field>
            <Field label="Applies in scenario" hint="“Any” answers in every scenario." className="sm:col-span-2">
              <Select value={d.scenarioId ?? ""} onChange={(e) => set("scenarioId", e.target.value || null)}>
                <option value="">Any scenario</option>{scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Priority" hint="Lower runs first."><Input type="number" value={d.priority} onChange={(e) => set("priority", Number(e.target.value))} disabled={d.isDefault} /></Field>
            <Field label="Fallback">
              <label className="flex h-[34px] items-center gap-2 text-sm"><input type="checkbox" checked={d.isDefault} onChange={(e) => setD((x) => ({ ...x, isDefault: e.target.checked, conditions: e.target.checked ? [] : x.conditions }))} /> Default rule</label>
            </Field>
          </div>

          {!d.isDefault && (
            <Field label="Use this rule when ALL of these match" hint="Rules are tried in priority order; the first whose conditions all match answers. The default rule answers when none do.">
              <MatcherEditor value={d.conditions} onChange={(v) => set("conditions", v)} />
              {d.conditions.length === 0 && !d.scenarioId && (
                <span role="alert" className="mt-2 block rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                  With no conditions and no scenario this rule matches every request, so the rules after it and the default rule will never answer. Add a condition, pick a scenario, or tick “Default rule”.
                </span>
              )}
            </Field>
          )}

          <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
            {soapOperation === undefined ? <Field label="Content type"><Input list="content-types" value={d.contentType} onChange={(e) => set("contentType", e.target.value)} className="font-mono" /><datalist id="content-types">{CONTENT_TYPES.map((c) => <option key={c} value={c} />)}</datalist></Field> : <p className="self-end pb-2 text-xs text-zinc-500">Content type follows the client&apos;s SOAP version.</p>}
            <Field label="Extra response headers"><KeyValueEditor value={d.headers} onChange={(v) => set("headers", v)} /></Field>
          </div>

          <Field label="Response body" hint={soapOperation !== undefined ? <>The XML inside the SOAP Body: the envelope is added for you (SOAP 1.1 or 1.2, matching the request). Echo a request value with <code>{"{{xml request.body.Op.Field}}"}</code>. For an error use status 500 and <code>{'{{soapFault "Client" "Insufficient balance"}}'}</code>.</> : <>Template: <code>{"{{request.params.id}}"}</code> <code>{"{{request.body.user.name}}"}</code> <code>{"{{vars.name}}"}</code> <code>{"{{uuid}}"}</code> <code>{"{{now}}"}</code> <code>{'{{faker "person.fullName"}}'}</code> <code>{"{{json value}}"}</code> <code>{"{{#repeat 3}}…{{/repeat}}"}</code></>}>
            <CodeEditor label="Response body" value={d.body} onChange={(v) => set("body", v)} minRows={10} language={soapOperation !== undefined || /xml|html/.test(d.contentType) ? "xml" : /json/.test(d.contentType) ? "json" : "text"} />
          </Field>

          <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
            <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold text-zinc-500">Live preview against a sample request</span><Button small onClick={runPreview}>Render preview</Button></div>
            <div className="grid gap-3 lg:grid-cols-2">
              <Textarea rows={6} value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Sample request JSON" />
              <pre className={`min-h-[8.5rem] overflow-auto rounded-md border p-2 font-mono text-xs ${preview && !preview.ok ? "border-red-300 text-red-700" : "border-zinc-200 dark:border-zinc-800"}`}>{preview ? preview.text : "Click “Render preview”."}</pre>
            </div>
          </div>

          <ErrorText>{error}</ErrorText>
          <div className="flex items-center justify-between">
            <Button variant="danger" small onClick={() => confirm(`Delete rule "${rule.name}"?`) && mutate("DELETE", `/rules/${rule.id}`, undefined, { ok: "Rule deleted" })}>Delete rule</Button>
            <div className="flex gap-2">
              <Button disabled={dirty} title={dirty ? "Save or discard your changes first: the copy is made from the saved rule" : undefined} onClick={() => mutate("POST", `/rules/${rule.id}/duplicate`, undefined, { ok: "Rule duplicated" })}>Duplicate</Button>
              <Button disabled={!dirty} onClick={() => { setD(editable(rule)); setError(undefined); }}>Discard changes</Button>
              <Button variant="primary" disabled={!dirty} onClick={save}>Save rule <span className="text-[10px] opacity-70">Ctrl+S</span></Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

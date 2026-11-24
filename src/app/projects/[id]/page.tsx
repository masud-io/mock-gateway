"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { LogTable } from "@/components/log-table";
import { useMutate } from "@/components/providers";
import { VariablesEditor } from "@/components/variables-editor";
import { Badge, Button, Card, Empty, ErrorText, Field, Input, MockUrl, Select } from "@/components/ui";
import { api, type ProjectDetail } from "@/lib/api";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const mutate = useMutate();
  const { data, error } = useQuery({ queryKey: ["project", id], queryFn: () => api<ProjectDetail>("GET", `/projects/${id}`) });

  const [scenario, setScenario] = useState("");
  const [colName, setColName] = useState("");
  const [colProto, setColProto] = useState<"rest" | "soap">("rest");
  const [formError, setFormError] = useState<string>();
  const [importNotes, setImportNotes] = useState<string[]>([]);

  if (error) return <div className="p-6"><ErrorText>{(error as Error).message}</ErrorText></div>;
  if (!data) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;
  const { project, client, scenarios, collections } = data;
  const active = scenarios.find((s) => s.id === project.activeScenarioId);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-xs text-zinc-500">{client.name} / Project</p>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold">{project.name}</h1>
          <Button variant="danger" small onClick={async () => {
            if (!confirm(`Delete project "${project.name}"? Its mocks stop responding immediately.`)) return;
            const r = await mutate("DELETE", `/projects/${id}`, undefined, { ok: "Project deleted" });
            if (!r.error) router.push("/");
          }}>Delete project</Button>
        </div>
        <MockUrl path={data.mockBase} />
      </header>

      <Card title="Simulation controls" actions={project.outage ? <Badge tone="red">OUTAGE ON</Badge> : <Badge tone="green">Healthy</Badge>}>
        <p className="mb-3 text-xs text-zinc-500">These apply to <strong>every API in this project at once</strong>.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Active scenario" hint={active?.description ?? "Rules tied to a scenario only answer while it's active."}>
            <Select value={project.activeScenarioId ?? ""} onChange={(e) => mutate("PATCH", `/projects/${id}`, { activeScenarioId: e.target.value || null }, { ok: "Scenario switched" })}>
              <option value="">None (default behaviour)</option>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Extra latency (ms)" hint="Added to every response. Saved when you leave the field.">
            <Input type="number" min={0} max={60000} defaultValue={project.globalLatencyMs} key={project.globalLatencyMs}
              onBlur={(e) => { const n = Number(e.target.value) || 0; if (n !== project.globalLatencyMs) mutate("PATCH", `/projects/${id}`, { globalLatencyMs: n }, { ok: "Latency updated" }); }} />
          </Field>
          <Field label="Outage" hint="Every request returns 503, whatever the endpoint.">
            <Button variant={project.outage ? "danger" : "secondary"} onClick={() => mutate("PATCH", `/projects/${id}`, { outage: !project.outage }, { ok: project.outage ? "Outage ended" : "Outage started" })}>
              {project.outage ? "End outage" : "Simulate outage"}
            </Button>
          </Field>
        </div>
      </Card>

      <Card title="Third-party APIs (collections)">
        {collections.length === 0 ? (
          <Empty>No APIs yet. Add one collection per third-party API this project calls (for example “Payments”, “Shipping”).</Empty>
        ) : (
          <ul className="mb-4 grid gap-3 sm:grid-cols-2">
            {collections.map((c) => (
              <li key={c.id}>
                <Link href={`/collections/${c.id}`} className="block rounded-md border border-zinc-200 p-3 hover:border-indigo-400 dark:border-zinc-800">
                  <div className="flex items-center justify-between"><span className="font-medium">{c.name}</span><Badge tone="indigo">{c.protocol.toUpperCase()}</Badge></div>
                  <p className="mt-1 truncate font-mono text-xs text-zinc-500">{c.mockBase}</p>
                  <p className="mt-1 text-xs text-zinc-500">{c.endpointCount} endpoint{c.endpointCount === 1 ? "" : "s"}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
          e.preventDefault();
          const r = await mutate<{ id: string }>("POST", "/collections", { projectId: id, name: colName.trim(), protocol: colProto }, { ok: "Collection created", silentError: true });
          setFormError(r.error);
          if (r.data) { setColName(""); router.push(`/collections/${r.data.id}`); }
        }}>
          <Field label="New API name" className="w-56"><Input value={colName} onChange={(e) => setColName(e.target.value)} placeholder="Payments API" required /></Field>
          <Field label="Protocol">
            <Select value={colProto} onChange={(e) => setColProto(e.target.value as "rest" | "soap")}>
              <option value="rest">REST</option><option value="soap">SOAP</option>
            </Select>
          </Field>
          <Button type="submit" variant="primary" disabled={!colName.trim()}>Add API</Button>
        </form>
        <div className="mt-2"><ErrorText>{formError}</ErrorText></div>
        <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <Field label="Import an API from a file" hint="A .mockgw.json file from another project or machine. It is added as a new API; nothing existing is changed.">
            <input type="file" accept=".json,application/json" className="block text-sm file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm dark:file:border-zinc-700 dark:file:bg-zinc-900"
              onChange={async (e) => {
                const input = e.target;
                const f = input.files?.[0];
                if (!f) return;
                setImportNotes([]);
                let parsed: unknown;
                try {
                  parsed = JSON.parse(await f.text());
                } catch {
                  setFormError("That file is not valid JSON.");
                  input.value = "";
                  return;
                }
                const r = await mutate<{ id: string; name: string; endpoints: number; rules: number; warnings: string[] }>("POST", `/projects/${id}/import`, parsed, { ok: "API imported", silentError: true });
                setFormError(r.error);
                if (r.data) setImportNotes([`Imported “${r.data.name}”: ${r.data.endpoints} endpoint(s), ${r.data.rules} rule(s).`, ...r.data.warnings]);
                input.value = "";
              }} />
          </Field>
          {importNotes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-zinc-600 dark:text-zinc-400">{importNotes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Scenarios">
          {scenarios.length === 0 && <p className="mb-3 text-sm text-zinc-500">A scenario is a named situation, like “payment-fails”. Tie response rules to it, then switch it on above.</p>}
          <ul className="mb-3 divide-y divide-zinc-100 dark:divide-zinc-900">
            {scenarios.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-1.5 text-sm">
                <span>{s.name} {s.id === project.activeScenarioId && <Badge tone="green">active</Badge>}</span>
                <Button small variant="ghost" onClick={() => confirm(`Delete scenario "${s.name}"? Rules that only apply in it are deleted too.`) && mutate("DELETE", `/scenarios/${s.id}`, undefined, { ok: "Scenario deleted" })}>Delete</Button>
              </li>
            ))}
          </ul>
          <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); const r = await mutate("POST", `/projects/${id}/scenarios`, { name: scenario.trim() }, { ok: "Scenario added" }); if (!r.error) setScenario(""); }}>
            <Input value={scenario} onChange={(e) => setScenario(e.target.value)} placeholder="payment-fails" aria-label="Scenario name" required />
            <Button type="submit" variant="primary" disabled={!scenario.trim()}>Add</Button>
          </form>
        </Card>
        <Card title="Project variables"><VariablesEditor scope="project" scopeId={id} variables={data.variables} /></Card>
      </div>

      <Card title="Live request log"><LogTable projectId={id} limit={30} /></Card>
    </div>
  );
}

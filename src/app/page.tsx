"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useMutate } from "@/components/providers";
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Select } from "@/components/ui";
import { api, type TreeClient } from "@/lib/api";

export default function Home() {
  const { data, error } = useQuery({ queryKey: ["tree"], queryFn: () => api<TreeClient[]>("GET", "/tree") });
  const mutate = useMutate();
  const [clientName, setClientName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectClient, setProjectClient] = useState("");
  const [formError, setFormError] = useState<string>();

  const clientId = projectClient || data?.[0]?.id || "";

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-bold">Mock API Gateway</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Organise mocks as <strong>Client → Project → Collection</strong>. A project is the app you&apos;re building; each collection is one third-party API it talks to.
        </p>
      </header>

      <ErrorText>{error ? (error as Error).message : undefined}</ErrorText>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="New client">
          <form className="space-y-3" onSubmit={async (e) => {
            e.preventDefault();
            const r = await mutate("POST", "/clients", { name: clientName.trim() }, { ok: "Client created", silentError: true });
            setFormError(r.error);
            if (!r.error) setClientName("");
          }}>
            <Field label="Client name"><Input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Acme Corp" required /></Field>
            <Button type="submit" variant="primary" disabled={!clientName.trim()}>Create client</Button>
          </form>
        </Card>
        <Card title="New project">
          {data && data.length === 0 ? (
            <p className="text-sm text-zinc-500">Create a client first.</p>
          ) : (
            <form className="space-y-3" onSubmit={async (e) => {
              e.preventDefault();
              const r = await mutate<{ id: string }>("POST", "/projects", { clientId, name: projectName.trim() }, { ok: "Project created", silentError: true });
              setFormError(r.error);
              if (!r.error) setProjectName("");
            }}>
              <Field label="Client">
                <Select value={clientId} onChange={(e) => setProjectClient(e.target.value)}>{data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              </Field>
              <Field label="Project name"><Input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Checkout" required /></Field>
              <Button type="submit" variant="primary" disabled={!projectName.trim() || !clientId}>Create project</Button>
            </form>
          )}
        </Card>
      </div>
      <ErrorText>{formError}</ErrorText>

      {data?.length === 0 && <Empty>Nothing here yet. Create a client, then a project, then add a collection for each third-party API.</Empty>}

      {data?.map((c) => (
        <Card key={c.id} title={c.name} actions={<>
          <Badge>{c.projects.length} project{c.projects.length === 1 ? "" : "s"}</Badge>
          <Button small variant="danger" onClick={async () => {
            const n = c.projects.length;
            if (!confirm(`Delete client "${c.name}"?${n ? ` Its ${n} project${n === 1 ? "" : "s"} and all their mocks stop responding immediately.` : ""}`)) return;
            await mutate("DELETE", `/clients/${c.id}`, undefined, { ok: "Client deleted" });
          }}>Delete</Button>
        </>}>
          {c.projects.length === 0 ? (
            <p className="text-sm text-zinc-500">No projects yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {c.projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2">
                  <Link href={`/projects/${p.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">{p.name}</Link>
                  <span className="flex items-center gap-2 text-xs text-zinc-500">
                    {p.outage && <Badge tone="red">OUTAGE</Badge>}
                    {p.collections.length} API{p.collections.length === 1 ? "" : "s"} · {p.collections.reduce((n, x) => n + x.endpoints.length, 0)} endpoints
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}

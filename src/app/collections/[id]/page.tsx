"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AuthCard } from "@/components/auth-card";
import { LogTable } from "@/components/log-table";
import { useMutate } from "@/components/providers";
import { VariablesEditor } from "@/components/variables-editor";
import { Badge, Button, Card, Empty, ErrorText, Field, Input, KeyValueEditor, MethodBadge, MockUrl, Select, Textarea, useOrigin } from "@/components/ui";
import { api, type CollectionDetail, type ErrorTemplate } from "@/lib/api";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"];

export default function CollectionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const mutate = useMutate();
  const { data, error } = useQuery({ queryKey: ["collection", id], queryFn: () => api<CollectionDetail>("GET", `/collections/${id}`) });

  const [name, setName] = useState("");
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [operation, setOperation] = useState("");
  const [soapAction, setSoapAction] = useState("");
  const [formError, setFormError] = useState<string>();

  if (error) return <div className="p-6"><ErrorText>{(error as Error).message}</ErrorText></div>;
  if (!data) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;
  const { collection, project, client } = data;
  const soap = collection.protocol === "soap";

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-xs text-zinc-500">{client.name} / <Link href={`/projects/${project.id}`} className="hover:underline">{project.name}</Link> / API</p>
        <div className="flex items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-xl font-bold">{collection.name} <Badge tone="indigo">{collection.protocol.toUpperCase()}</Badge></h1>
          <Button variant="danger" small onClick={async () => {
            if (!confirm(`Delete "${collection.name}" and stop serving its endpoints?`)) return;
            const r = await mutate("DELETE", `/collections/${id}`, undefined, { ok: "Collection deleted" });
            if (!r.error) router.push(`/projects/${project.id}`);
          }}>Delete</Button>
        </div>
        <MockUrl path={data.mockBase} />
        <p className="text-xs text-zinc-500">Point your app at this base URL instead of the real provider. Paths after it are the provider&apos;s own paths.</p>
      </header>

      <Card title="Endpoints" actions={<Link href={`/collections/${id}/wizard`} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700">+ From a sample</Link>}>
        {data.endpoints.length === 0 ? (
          <Empty>No endpoints yet. Paste a sample from the provider&apos;s docs (“From a sample”), or add one below.</Empty>
        ) : (
          <ul className="mb-4 divide-y divide-zinc-100 dark:divide-zinc-900">
            {data.endpoints.map((e) => (
              <li key={e.id}>
                <Link href={`/endpoints/${e.id}`} className={`flex items-center gap-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-900 ${e.enabled ? "" : "opacity-50"}`}>
                  {soap ? <Badge tone="indigo">OP</Badge> : <MethodBadge method={e.method} />}<code className="font-mono text-sm">{soap ? e.operation : e.path}</code><span className="text-sm text-zinc-500">{soap ? e.soapAction ?? "" : e.name}</span>{!e.enabled && <Badge>disabled</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <form className="flex flex-wrap items-start gap-2" onSubmit={async (e) => {
          e.preventDefault();
          const r = await mutate<{ id: string }>("POST", "/endpoints", soap ? { collectionId: id, name: name.trim(), operation: operation.trim(), soapAction: soapAction.trim() } : { collectionId: id, name: name.trim(), method, path: path.trim() }, { ok: "Endpoint created", silentError: true });
          setFormError(r.error);
          if (r.data) { setName(""); setPath("/"); setOperation(""); setSoapAction(""); router.push(`/endpoints/${r.data.id}`); }
        }}>
          <Field label="Name" className="w-44"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Get order" required /></Field>
          {soap ? (
            <>
              <Field label="Operation" className="w-52" hint="First element inside the SOAP Body"><Input value={operation} onChange={(e) => setOperation(e.target.value)} placeholder="GetOrder" className="font-mono" required /></Field>
              <Field label="SOAPAction (optional)" className="min-w-52 flex-1"><Input value={soapAction} onChange={(e) => setSoapAction(e.target.value)} placeholder="urn:orders/GetOrder" className="font-mono" /></Field>
            </>
          ) : (
            <>
              <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m} value={m}>{m === "*" ? "ANY" : m}</option>)}</Select></Field>
              <Field label="Path" className="min-w-52 flex-1" hint="Use :name for parameters, * for the rest of the path"><Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/orders/:id" className="font-mono" required /></Field>
            </>
          )}
          <Button type="submit" variant="primary" className="mt-5" disabled={!name.trim() || (soap && !operation.trim())}>Add endpoint</Button>
        </form>
        <div className="mt-2"><ErrorText>{formError}</ErrorText></div>
      </Card>

      {soap && <WsdlCard collectionId={id} hasWsdl={!!collection.wsdl} mockBase={data.mockBase} />}
      <Settings key={collection.updatedAt} data={data} />
      <AuthCard collectionId={id} scheme={data.authScheme} />
      <Card title="API variables"><VariablesEditor scope="collection" scopeId={id} variables={data.variables} /></Card>
      <Card title="Live request log"><LogTable collectionId={id} limit={30} /></Card>
    </div>
  );
}

function WsdlCard({ collectionId, hasWsdl, mockBase }: { collectionId: string; hasWsdl: boolean; mockBase: string }) {
  const mutate = useMutate();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [report, setReport] = useState<{ created: string[]; skipped: string[]; version: string; warnings: string[] } | null>(null);
  const origin = useOrigin();
  return (
    <Card title="Import a WSDL" actions={hasWsdl ? <Badge tone="green">WSDL imported</Badge> : undefined}>
      <p className="mb-3 text-sm text-zinc-500">Paste the provider&apos;s WSDL. Every operation becomes an endpoint with a sample response generated from its schema. Operations you already have are left alone.{hasWsdl && <> Your app can read it from <code className="break-all">{origin}{mockBase}?wsdl</code>, with the service address pointing at this mock.</>}</p>
      <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="<definitions …>" aria-label="WSDL document" />
      <div className="mt-2 flex items-center gap-3">
        <Button variant="primary" disabled={!text.trim()} onClick={async () => {
          const r = await mutate<NonNullable<typeof report>>("POST", `/collections/${collectionId}/wsdl`, { wsdl: text }, { ok: "WSDL imported", silentError: true });
          setError(r.error);
          if (r.data) { setReport(r.data); setText(""); }
        }}>Import</Button>
        <ErrorText>{error}</ErrorText>
      </div>
      {report && (
        <div className="mt-3 space-y-1 text-sm" role="status">
          <p>SOAP {report.version}: added {report.created.length ? report.created.join(", ") : "nothing new"}{report.skipped.length > 0 && <>; kept existing {report.skipped.join(", ")}</>}.</p>
          {report.warnings.map((w) => <p key={w} className="text-amber-700 dark:text-amber-400">{w}</p>)}
        </div>
      )}
    </Card>
  );
}

function Settings({ data }: { data: CollectionDetail }) {
  const { collection } = data;
  const mutate = useMutate();
  const [name, setName] = useState(collection.name);
  const [validationMode, setValidationMode] = useState(collection.validationMode);
  const [headers, setHeaders] = useState<Record<string, string>>(collection.defaultHeaders);
  const [custom, setCustom] = useState(!!collection.errorTemplate);
  const [errTpl, setErrTpl] = useState<ErrorTemplate>(collection.errorTemplate ?? { status: 400, contentType: "application/json", body: '{"error":"Invalid request","details":{{json errors}}}' });
  const [error, setError] = useState<string>();

  return (
    <Card title="Settings">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Mode" hint="Pass-through and record arrive in a later step."><Select value="mock" disabled><option value="mock">Mock</option><option>Pass-through</option><option>Record</option></Select></Field>
        <Field label="Request validation" hint="Checks request bodies against each endpoint's JSON Schema.">
          <Select value={validationMode} onChange={(e) => setValidationMode(e.target.value as typeof validationMode)}>
            <option value="strict">Reject invalid requests (strict)</option><option value="warn">Allow and log (warn)</option><option value="off">Off</option>
          </Select>
        </Field>
        <div />
        <Field label="Default response headers" className="sm:col-span-2" hint="Sent with every response from this API; a rule can override them.">
          <KeyValueEditor value={headers} onChange={setHeaders} />
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} /> Use the provider&apos;s own validation-error response</label>
          {custom && (
            <div className="grid gap-2 sm:grid-cols-[6rem_1fr]">
              <Field label="Status"><Input type="number" value={errTpl.status} onChange={(e) => setErrTpl({ ...errTpl, status: Number(e.target.value) })} /></Field>
              <Field label="Content type"><Input value={errTpl.contentType} onChange={(e) => setErrTpl({ ...errTpl, contentType: e.target.value })} className="font-mono" /></Field>
              <Field label="Body" className="sm:col-span-2" hint={<>Template. <code>{"{{json errors}}"}</code> is the list of validation messages.</>}><Textarea rows={4} value={errTpl.body} onChange={(e) => setErrTpl({ ...errTpl, body: e.target.value })} /></Field>
            </div>
          )}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={async () => {
          const r = await mutate("PATCH", `/collections/${collection.id}`, { name: name.trim(), validationMode, defaultHeaders: headers, errorTemplate: custom ? errTpl : null }, { ok: "Settings saved", silentError: true });
          setError(r.error);
        }}>Save settings</Button>
      </div>
      <div className="mt-2"><ErrorText>{error}</ErrorText></div>
    </Card>
  );
}

"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useMutate } from "@/components/providers";
import { Badge, Button, Card, ErrorText, Field, Input, JsonField, Select, Textarea } from "@/components/ui";
import { api, ApiError, type CollectionDetail } from "@/lib/api";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

interface Analysis {
  name: string; method: string; path: string; pathParams: Record<string, string>; query: Record<string, string>;
  requestSchema: unknown; requestBody: unknown; status: number; contentType: string; body: string;
  substitutions: { at: string; sample: string; token: string; reason: string }[];
  warnings: string[];
  soap?: boolean; operation?: string; soapAction?: string | null; soapVersion?: string;
}

export default function WizardPage() {
  const { id } = useParams<{ id: string }>();
  const { data } = useQuery({ queryKey: ["collection", id], queryFn: () => api<CollectionDetail>("GET", `/collections/${id}`) });
  const [result, setResult] = useState<Analysis | null>(null);
  // The request that produced `result`, used to render a realistic preview
  const [sampleBody, setSampleBody] = useState<unknown>(null);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-1">
        <p className="text-xs text-zinc-500">
          {data ? <>{data.client.name} / <Link href={`/projects/${data.project.id}`} className="hover:underline">{data.project.name}</Link> / <Link href={`/collections/${id}`} className="hover:underline">{data.collection.name}</Link></> : "…"}
        </p>
        <h1 className="text-xl font-bold">Create an endpoint from a sample</h1>
        <p className="text-sm text-zinc-500">Paste a request and response from the provider&apos;s documentation. IDs and timestamps become generated values, and fields echoed from the request stay in sync with it.</p>
      </header>

      {!data ? <p className="text-sm text-zinc-500">Loading…</p> : !result ? (
        <PasteStep collectionId={id} soap={data.collection.protocol === "soap"} onDone={(a, body) => { setResult(a); setSampleBody(body); }} />
      ) : (
        <ReviewStep key={result.name + result.path} collectionId={id} initial={result} sampleBody={sampleBody} onBack={() => setResult(null)} />
      )}
    </div>
  );
}

function PasteStep({ collectionId, soap, onDone }: { collectionId: string; soap: boolean; onDone: (a: Analysis, requestBody: unknown) => void }) {
  const [mode, setMode] = useState<"curl" | "manual">("curl");
  const [curl, setCurl] = useState("");
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [reqBody, setReqBody] = useState("");
  const [soapAction, setSoapAction] = useState("");
  const [status, setStatus] = useState(200);
  const [resBody, setResBody] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const analyze = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const payload = mode === "curl" ? { curl } : soap ? { requestBody: reqBody, soapAction } : { method, url, requestBody: reqBody };
      const a = await api<Analysis>("POST", `/collections/${collectionId}/wizard/analyze`, { ...payload, responseStatus: status, responseBody: resBody });
      onDone(a, a.requestBody);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Analysis failed");
    } finally {
      setBusy(false);
    }
  };
  const ready = (mode === "curl" ? curl.trim() : soap ? reqBody.trim() : url.trim()) !== "";

  return (
    <div className="space-y-4">
      <Card title="1 · The request">
        <div className="mb-3 flex gap-2" role="tablist">
          <Button small variant={mode === "curl" ? "primary" : "secondary"} role="tab" aria-selected={mode === "curl"} onClick={() => setMode("curl")}>Paste cURL</Button>
          <Button small variant={mode === "manual" ? "primary" : "secondary"} role="tab" aria-selected={mode === "manual"} onClick={() => setMode("manual")}>Enter manually</Button>
        </div>
        {mode === "curl" ? (
          <Field label="cURL command" hint="Credentials in it are only used to read the request: nothing from the headers is stored.">
            <Textarea rows={5} value={curl} onChange={(e) => setCurl(e.target.value)} placeholder={`curl -X POST https://api.provider.com/v1/orders \\\n  -H 'Content-Type: application/json' \\\n  -d '{"amount": 1200, "currency": "USD"}'`} />
          </Field>
        ) : (
          soap ? (
            <div className="space-y-3">
              <Field label="SOAP request" hint="Paste the full envelope, or just the XML that goes inside the Body (it gets a default envelope). The first element names the operation."><Textarea rows={8} value={reqBody} onChange={(e) => setReqBody(e.target.value)} placeholder="<GetOrderRequest>…</GetOrderRequest>" /></Field>
              <Field label="SOAPAction (optional)" hint="From the documentation or the SOAPAction header."><Input value={soapAction} onChange={(e) => setSoapAction(e.target.value)} placeholder="urn:orders/GetOrder" className="font-mono" /></Field>
            </div>
          ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m}>{m}</option>)}</Select></Field>
              <Field label="URL or path" hint="A full URL is fine: only the path is used."><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.provider.com/v1/orders/12345" className="font-mono" /></Field>
            </div>
            <Field label="Request body (optional)"><Textarea rows={5} value={reqBody} onChange={(e) => setReqBody(e.target.value)} placeholder='{ "amount": 1200 }' /></Field>
          </div>
          )
        )}
      </Card>

      <Card title="2 · The response">
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <Field label="Status" hint={soap ? "A SOAP Fault is normally 500." : undefined}><Input type="number" min={100} max={599} value={status} onChange={(e) => setStatus(Number(e.target.value))} /></Field>
        </div>
        <div className="mt-3">
          <Field label="Response body" hint={soap ? "The whole response envelope, or just the XML inside its Body." : "JSON, XML or text. Leave empty for responses without a body."}>
            <Textarea rows={12} value={resBody} onChange={(e) => setResBody(e.target.value)} placeholder='{ "id": "ord_8f3k29dkx1", "amount": 1200, "created": "2024-05-01T10:00:00Z" }' />
          </Field>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={analyze} disabled={!ready || busy}>{busy ? "Analyzing…" : "Analyze sample"}</Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}

function ReviewStep({ collectionId, initial, sampleBody, onBack }: { collectionId: string; initial: Analysis; sampleBody: unknown; onBack: () => void }) {
  const router = useRouter();
  const mutate = useMutate();
  const [name, setName] = useState(initial.name);
  const [method, setMethod] = useState(initial.method);
  const [path, setPath] = useState(initial.path);
  const [operation, setOperation] = useState(initial.operation ?? "");
  const [soapAction, setSoapAction] = useState(initial.soapAction ?? "");
  const soap = !!initial.soap;
  const [schema, setSchema] = useState<unknown>(initial.requestSchema);
  const [status, setStatus] = useState(initial.status);
  const [contentType, setContentType] = useState(initial.contentType);
  const [body, setBody] = useState(initial.body);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{ ok: boolean; text: string } | null>(null);

  const runPreview = async () => {
    try {
      const r = await api<{ output: string }>("POST", "/preview", { template: body, request: { method, path, params: initial.pathParams, body: sampleBody } });
      let text = r.output;
      try { text = JSON.stringify(JSON.parse(r.output), null, 2); } catch { /* not JSON */ }
      setPreview({ ok: true, text });
    } catch (e) {
      setPreview({ ok: false, text: e instanceof ApiError ? e.message : "Preview failed" });
    }
  };

  const save = async () => {
    const r = await mutate<{ id: string }>(
      "POST", `/collections/${collectionId}/wizard/create`,
      soap ? { name: name.trim(), method: "POST", path: path.trim() || "/", status, contentType, body, operation: operation.trim(), soapAction: soapAction.trim() || null } : { name: name.trim(), method, path, requestSchema: schema ?? null, status, contentType, body },
      { ok: "Endpoint created — live now", silentError: true },
    );
    setError(r.error);
    if (r.data) router.push(`/endpoints/${r.data.id}`);
  };

  return (
    <div className="space-y-4">
      {initial.warnings.length > 0 && (
        <div role="alert" className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          {initial.warnings.map((w) => <p key={w}>{w}</p>)}
        </div>
      )}

      <Card title="Endpoint">
        {soap ? (
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Operation" hint={`SOAP ${initial.soapVersion ?? "1.1"}`}><Input value={operation} onChange={(e) => setOperation(e.target.value)} className="font-mono" /></Field>
            <Field label="Path (optional)" hint="The provider's own path, e.g. /getToken. Only used for the URL you copy: requests are matched by operation."><Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/getToken" className="font-mono" /></Field>
            <Field label="SOAPAction"><Input value={soapAction} onChange={(e) => setSoapAction(e.target.value)} className="font-mono" /></Field>
          </div>
        ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_2fr]">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{[...METHODS, "*"].map((m) => <option key={m} value={m}>{m === "*" ? "ANY" : m}</option>)}</Select></Field>
          <Field label="Path" hint={Object.keys(initial.pathParams).length ? <>Detected {Object.entries(initial.pathParams).map(([k, v]) => <span key={k}><code>:{k}</code> from <code>{v}</code> </span>)}</> : "No parameters detected."}>
            <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" />
          </Field>
        </div>
        )}
        {Object.keys(initial.query).length > 0 && <p className="mt-2 text-xs text-zinc-500">Query parameters in the sample (<code>{Object.keys(initial.query).join(", ")}</code>) are not part of the path. Add conditions on the endpoint page if the response depends on them.</p>}
        {!soap && <div className="mt-4">
          <Field label="Request body JSON Schema" hint="Inferred from the sample: every field present is marked required. Loosen it if the provider's fields are optional. Clear it to skip validation.">
            <JsonField value={schema} onChange={setSchema} rows={8} />
          </Field>
        </div>}
      </Card>

      <Card title="Response">
        <div className="grid gap-3 sm:grid-cols-[8rem_14rem]">
          <Field label="Status"><Input type="number" min={100} max={599} value={status} onChange={(e) => setStatus(Number(e.target.value))} /></Field>
          {!soap && <Field label="Content type"><Input value={contentType} onChange={(e) => setContentType(e.target.value)} className="font-mono" /></Field>}
        </div>

        <div className="mt-3">
          <Field label="Response body template">
            <Textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
        </div>

        <div className="mt-3 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
          <p className="mb-2 text-xs font-semibold text-zinc-500">What was turned into a generated value ({initial.substitutions.length})</p>
          {initial.substitutions.length === 0 ? (
            <p className="text-xs text-zinc-500">Nothing: the response is returned exactly as pasted. Add <code>{"{{uuid}}"}</code>, <code>{"{{now}}"}</code> or <code>{"{{request.body.…}}"}</code> yourself where values should vary.</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-zinc-500"><th className="pb-1 pr-3">Field</th><th className="pb-1 pr-3">Sample</th><th className="pb-1 pr-3">Now</th><th className="pb-1">Why</th></tr></thead>
              <tbody>
                {initial.substitutions.map((s) => (
                  <tr key={s.at} className="border-t border-zinc-200 align-top dark:border-zinc-800">
                    <td className="py-1 pr-3 font-mono">{s.at}</td>
                    <td className="py-1 pr-3 font-mono break-all">{s.sample}</td>
                    <td className="py-1 pr-3 font-mono break-all"><Badge tone="indigo">{s.token}</Badge></td>
                    <td className="py-1 text-zinc-500">{s.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold text-zinc-500">Preview, using the request you pasted</span><Button small onClick={runPreview}>Render preview</Button></div>
          <pre className={`min-h-[4rem] overflow-auto rounded-md border p-2 font-mono text-xs ${preview && !preview.ok ? "border-red-300 text-red-700" : "border-zinc-200 dark:border-zinc-800"}`}>{preview ? preview.text : "Click “Render preview”."}</pre>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={onBack}>← Back to the sample</Button>
        <Button variant="primary" onClick={save} disabled={!name.trim() || (soap ? !operation.trim() : !path.trim())}>Create endpoint</Button>
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}

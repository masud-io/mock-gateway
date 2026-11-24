"use client";

import { useState } from "react";
import { useMutate } from "./providers";
import { Badge, Button, Card, Field, Input, Select, StatusBadge, Textarea, useOrigin } from "./ui";

interface Result { status: number; ms: number; headers: [string, string][]; body: string; error?: string }

const storageKey = (collectionId: string) => `mockgw:tryit-headers:${collectionId}`;
function loadHeaders(collectionId: string): string {
  try {
    return localStorage.getItem(storageKey(collectionId)) ?? "";
  } catch {
    return "";
  }
}

/** Calls the real mock URL from the browser, so what you see is exactly what your app would get. */
export function TryIt({ collectionId, mockBase, method, path, soap }: { collectionId: string; mockBase: string; method: string; path: string; soap?: { operation: string; soapAction: string } }) {
  const origin = useOrigin();
  const mutate = useMutate();
  const [m, setM] = useState(soap ? "POST" : method === "*" ? "GET" : method);
  // Fill `:id` style params with a sample value so the URL is callable straight away
  const [p, setP] = useState(soap ? (path === "/" ? "" : path) : path.replace(/:[A-Za-z_]\w*/g, "1").replace(/\*/g, "example"));
  const [headers, setHeaders] = useState(() => loadHeaders(collectionId));
  const [body, setBody] = useState(() =>
    soap ? `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Body>\n    <${soap.operation}>\n    </${soap.operation}>\n  </soap:Body>\n</soap:Envelope>` : "",
  );
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      localStorage.setItem(storageKey(collectionId), headers);
    } catch {
      /* storage unavailable: the headers just aren't remembered */
    }
    const h = new Headers();
    for (const line of headers.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) {
        try { h.set(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch { /* skip an invalid header line */ }
      }
    }
    const hasBody = body.trim() && !["GET", "HEAD"].includes(m);
    if (hasBody && !h.has("content-type")) h.set("content-type", soap ? "text/xml; charset=utf-8" : "application/json");
    if (soap && !h.has("soapaction")) h.set("SOAPAction", `"${soap.soapAction}"`);
    const t = performance.now();
    try {
      const r = await fetch(`${mockBase}${p === "" || p.startsWith("/") ? p : `/${p}`}`, { method: m, headers: h, body: hasBody ? body : undefined });
      const text = await r.text();
      let shown = text;
      try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON: show as-is */ }
      setRes({ status: r.status, ms: Math.round(performance.now() - t), headers: [...r.headers.entries()], body: shown });
    } catch (e) {
      setRes({ status: 0, ms: Math.round(performance.now() - t), headers: [], body: "", error: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Try it" actions={<Badge>sends a real request to the mock</Badge>}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <div className="flex flex-wrap items-end gap-2">
          {soap ? (
            <p className="min-w-60 flex-1 break-all pb-2 font-mono text-xs text-zinc-500">POST {origin}{mockBase}{p}</p>
          ) : (
            <>
              <Field label="Method"><Select value={m} onChange={(e) => setM(e.target.value)} className="w-28">{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((x) => <option key={x}>{x}</option>)}</Select></Field>
              <Field label="Path" className="min-w-60 flex-1" hint={<span className="break-all">{origin}{mockBase}{p}</span>}><Input value={p} onChange={(e) => setP(e.target.value)} className="font-mono" /></Field>
            </>
          )}
          <Button title="Keep this request on the API's Requests page" onClick={() => {
            const hs: Record<string, string> = {};
            for (const line of headers.split("\n")) {
              const i = line.indexOf(":");
              if (i > 0 && line.slice(0, i).trim()) hs[line.slice(0, i).trim()] = line.slice(i + 1).trim();
            }
            return mutate("POST", `/collections/${collectionId}/requests`, { name: soap ? soap.operation || "SOAP request" : `${m} ${p || "/"}`, method: m, path: p, headers: hs, body: ["GET", "HEAD"].includes(m) ? "" : body }, { ok: "Saved to Requests" });
          }}>Save as request</Button>
          <Button variant="primary" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send"}</Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Headers (one per line, Name: value)" hint="Remembered for this API, e.g. its API key."><Textarea rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="x-api-key: sk_test_demo" /></Field>
          <Field label="Body"><Textarea rows={soap ? 7 : 3} value={body} onChange={(e) => setBody(e.target.value)} placeholder={soap ? "<soap:Envelope …>" : '{"amount": 10}'} disabled={["GET", "HEAD"].includes(m)} /></Field>
        </div>
        {res && (
          <div className="space-y-2" aria-live="polite">
            <div className="flex items-center gap-2">{res.error ? <Badge tone="red">failed</Badge> : <StatusBadge status={res.status} />}<span className="text-xs text-zinc-500">{res.ms} ms</span></div>
            {res.error && <p className="text-sm text-red-600">{res.error}</p>}
            {!res.error && (
              <>
                <pre className="max-h-72 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-xs dark:bg-zinc-900">{res.body || "(empty body)"}</pre>
                <details><summary className="cursor-pointer text-xs text-zinc-500">Response headers</summary><pre className="mt-1 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-xs dark:bg-zinc-900">{res.headers.map(([k, v]) => `${k}: ${v}`).join("\n")}</pre></details>
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

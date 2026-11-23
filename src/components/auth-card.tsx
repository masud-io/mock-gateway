"use client";

import { useState } from "react";
import { api, type AuthScheme, type ErrorTemplate } from "@/lib/api";
import { useMutate, useToast } from "./providers";
import { Badge, Button, Card, ErrorText, Field, Input, omitKey, Select, Textarea } from "./ui";

const TYPES: { value: AuthScheme["type"]; label: string }[] = [
  { value: "none", label: "None (open API)" },
  { value: "api_key", label: "API key" },
  { value: "bearer", label: "Bearer token" },
  { value: "basic", label: "Basic (user / password)" },
  { value: "oauth2", label: "OAuth2 bearer (checked like a bearer token for now)" },
  { value: "hmac", label: "HMAC signature of the body" },
];

const DEFAULT_FAIL: ErrorTemplate = { status: 401, contentType: "application/json", body: '{"error":"Unauthorized"}' };

export function AuthCard({ collectionId, scheme }: { collectionId: string; scheme: AuthScheme | null }) {
  // Remount when the saved scheme changes so the draft always starts from what's stored
  return <AuthForm key={scheme ? JSON.stringify([scheme.type, scheme.config, scheme.mode, scheme.onFail]) : "none"} collectionId={collectionId} scheme={scheme} />;
}

function AuthForm({ collectionId, scheme }: { collectionId: string; scheme: AuthScheme | null }) {
  const mutate = useMutate();
  const toast = useToast();
  const [type, setType] = useState<AuthScheme["type"]>(scheme?.type ?? "none");
  const [config, setConfig] = useState<Record<string, unknown>>(scheme?.config ?? {});
  const [mode, setMode] = useState<AuthScheme["mode"]>(scheme?.mode ?? "strict");
  const [custom, setCustom] = useState<boolean>(!!scheme?.onFail);
  const [fail, setFail] = useState<ErrorTemplate>(scheme?.onFail ?? DEFAULT_FAIL);
  const [error, setError] = useState<string>();

  const [label, setLabel] = useState("");
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const setCfg = (k: string, v: unknown) => setConfig((c) => ({ ...c, [k]: v }));

  return (
    <Card title="Authentication the mock enforces" actions={scheme && scheme.type !== "none" ? <Badge tone="green">{scheme.type.replace("_", " ")} · {scheme.mode}</Badge> : <Badge>open</Badge>}>
      <p className="mb-3 text-xs text-zinc-500">
        Real providers reject bad credentials with their own 401/403. Configure that here so your client&apos;s error handling gets tested.
        With <strong>no credentials added</strong>, any non-empty value is accepted.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Scheme"><Select value={type} onChange={(e) => setType(e.target.value as AuthScheme["type"])}>{TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field>
        <Field label="When it fails" hint={mode === "warn" ? "Request is allowed but the log records the failure." : mode === "off" ? "Not checked at all." : "Request is rejected."}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as AuthScheme["mode"])}><option value="strict">Reject (strict)</option><option value="warn">Allow and log (warn)</option><option value="off">Don&apos;t check (off)</option></Select>
        </Field>
        {type === "api_key" && (
          <>
            <Field label="Sent in"><Select value={String(config.in ?? "header")} onChange={(e) => setCfg("in", e.target.value)}><option value="header">Header</option><option value="query">Query string</option></Select></Field>
            <Field label="Name"><Input value={String(config.name ?? "x-api-key")} onChange={(e) => setCfg("name", e.target.value)} className="font-mono" /></Field>
          </>
        )}
        {type === "hmac" && (
          <>
            <Field label="Signature header"><Input value={String(config.header ?? "x-signature")} onChange={(e) => setCfg("header", e.target.value)} className="font-mono" /></Field>
            <Field label="Algorithm / encoding">
              <div className="flex gap-2">
                <Select value={String(config.algorithm ?? "sha256")} onChange={(e) => setCfg("algorithm", e.target.value)}><option>sha256</option><option>sha1</option><option>sha512</option></Select>
                <Select value={String(config.encoding ?? "hex")} onChange={(e) => setCfg("encoding", e.target.value)}><option value="hex">hex</option><option value="base64">base64</option></Select>
              </div>
            </Field>
          </>
        )}
      </div>

      {type !== "none" && (
        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} /> Use the provider&apos;s own error response</label>
          {custom && (
            <div className="grid gap-2 sm:grid-cols-[6rem_1fr]">
              <Field label="Status"><Input type="number" value={fail.status} onChange={(e) => setFail({ ...fail, status: Number(e.target.value) })} /></Field>
              <Field label="Content type"><Input value={fail.contentType} onChange={(e) => setFail({ ...fail, contentType: e.target.value })} className="font-mono" /></Field>
              <Field label="Body" className="sm:col-span-2"><Textarea rows={3} value={fail.body} onChange={(e) => setFail({ ...fail, body: e.target.value })} /></Field>
            </div>
          )}
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" onClick={async () => {
          const r = await mutate("PUT", `/collections/${collectionId}/auth`, { type, config, mode, onFail: type !== "none" && custom ? fail : null }, { ok: "Authentication saved", silentError: true });
          setError(r.error);
        }}>Save authentication</Button>
      </div>
      <div className="mt-2"><ErrorText>{error}</ErrorText></div>

      {scheme && scheme.type !== "none" && (
        <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <h3 className="mb-2 text-sm font-semibold">Accepted credentials</h3>
          {scheme.credentials.length === 0 ? (
            <p className="mb-3 text-sm text-zinc-500">None added: <strong>any value is accepted</strong>. Add one to make the mock reject everything else.</p>
          ) : (
            <ul className="mb-3 divide-y divide-zinc-100 dark:divide-zinc-900">
              {scheme.credentials.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                  <span>
                    <strong>{c.label}</strong> {c.keyId && <span className="text-zinc-500">({c.keyId})</span>}{" "}
                    <code className="font-mono text-xs">{revealed[c.id] ?? "••••••••"}</code> {!c.isActive && <Badge tone="amber">disabled</Badge>}
                  </span>
                  <span className="flex gap-1">
                    <Button small variant="ghost" onClick={async () => {
                      if (revealed[c.id]) return setRevealed((r) => omitKey(r, c.id) as Record<string, string>);
                      try { const { secret } = await api<{ secret: string }>("GET", `/credentials/${c.id}/reveal`); setRevealed((r) => ({ ...r, [c.id]: secret })); }
                      catch { toast("Couldn't reveal the secret", "error"); }
                    }}>{revealed[c.id] ? "Hide" : "Reveal"}</Button>
                    <Button small variant="ghost" onClick={() => mutate("PATCH", `/credentials/${c.id}`, { isActive: !c.isActive })}>{c.isActive ? "Disable" : "Enable"}</Button>
                    <Button small variant="ghost" onClick={() => mutate("DELETE", `/credentials/${c.id}`, undefined, { ok: "Credential removed" })}>Delete</Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
            e.preventDefault();
            const r = await mutate("POST", `/auth-schemes/${scheme.id}/credentials`, { label: label.trim(), keyId: scheme.type === "basic" ? keyId.trim() || null : null, secret }, { ok: "Credential added" });
            if (!r.error) { setLabel(""); setKeyId(""); setSecret(""); }
          }}>
            <Field label="Label" className="w-36"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="test key" required /></Field>
            {scheme.type === "basic" && <Field label="Username" className="w-36"><Input value={keyId} onChange={(e) => setKeyId(e.target.value)} required /></Field>}
            <Field label={scheme.type === "basic" ? "Password" : scheme.type === "hmac" ? "Shared secret" : "Key / token"} className="w-64"><Input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" className="font-mono" required /></Field>
            <Button type="submit" variant="primary" disabled={!label.trim() || !secret}>Add</Button>
          </form>
          <p className="mt-2 text-xs text-zinc-500">Stored encrypted. Never shown in the request log.</p>
        </div>
      )}
    </Card>
  );
}

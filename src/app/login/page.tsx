"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { api, ApiError, type AuthStatus } from "@/lib/api";

/** Only follow same-site paths after signing in (never "//evil.com" or a full URL). */
const safeNext = () => {
  const n = new URLSearchParams(location.search).get("next");
  return n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/login") ? n : "/";
};

export default function LoginPage() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["auth"], queryFn: () => api<AuthStatus>("GET", "/auth/status") });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (error) return <div className="p-6"><ErrorText>{(error as Error).message}</ErrorText></div>;
  if (!data) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;
  if (data.user) {
    location.replace(safeNext());
    return <p className="p-6 text-sm text-zinc-500">Signed in. Redirecting…</p>;
  }

  const setup = data.setupNeeded;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(undefined);
    try {
      await api("POST", setup ? "/auth/setup" : "/auth/login", setup ? { email, name, password } : { email, password });
      await qc.invalidateQueries();
      location.replace(safeNext());
    } catch (x) {
      setProblem(x instanceof ApiError ? x.message : "Network error: is the gateway running?");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-[12vh] max-w-sm px-4">
      <h1 className="mb-4 text-center text-xl font-bold tracking-tight">Mock API Gateway</h1>
      {setup && !data.canSetup ? (
        <Card title="No admin account yet">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            The first admin account can only be created on the machine that runs the gateway. Open <code>http://localhost:3000/login</code> there, create it, then come back here.
          </p>
        </Card>
      ) : (
        <form onSubmit={submit}>
          <Card title={setup ? "Create the first admin" : "Sign in"}>
            <div className="space-y-3">
              {setup && <p className="text-xs text-zinc-500">No admin exists yet. This account will be able to sign in from other machines and add more users.</p>}
              {setup && <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></Field>}
              <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required /></Field>
              <Field label="Password" hint={setup ? "At least 8 characters." : undefined}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? "new-password" : "current-password"} required /></Field>
              <ErrorText>{problem}</ErrorText>
              <Button type="submit" variant="primary" className="w-full" disabled={busy}>{busy ? "…" : setup ? "Create admin and sign in" : "Sign in"}</Button>
            </div>
          </Card>
        </form>
      )}
    </div>
  );
}

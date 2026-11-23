"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useMutate } from "@/components/providers";
import { Badge, Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { api } from "@/lib/api";

type U = { id: string; email: string; name: string; isActive: boolean; isMe: boolean };

export default function UsersPage() {
  const mutate = useMutate();
  const { data, error } = useQuery({ queryKey: ["users"], queryFn: () => api<U[]>("GET", "/auth/users") });
  const [nu, setNu] = useState({ email: "", name: "", password: "" });
  const [addErr, setAddErr] = useState<string>();
  const [pw, setPw] = useState({ current: "", next: "" });
  const [pwErr, setPwErr] = useState<string>();

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-xl font-bold">Users</h1>
      <p className="text-sm text-zinc-500">Everyone listed here can sign in to the admin UI and edit everything. Mock endpoints (<code>/mock/…</code>) never need a login.</p>

      <Card title="Admins">
        {error && <ErrorText>{(error as Error).message}</ErrorText>}
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {data?.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span><span className="font-medium">{u.name}</span> <span className="text-zinc-500">{u.email}</span> {u.isMe && <Badge tone="indigo">you</Badge>}</span>
              {!u.isMe && <Button small variant="danger" onClick={() => confirm(`Delete ${u.email}? They will be signed out.`) && mutate("DELETE", `/auth/users/${u.id}`, undefined, { ok: "User deleted" })}>Delete</Button>}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Add a user">
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={async (e) => { e.preventDefault(); const r = await mutate("POST", "/auth/users", nu, { ok: "User added", silentError: true }); setAddErr(r.error); if (!r.error) setNu({ email: "", name: "", password: "" }); }}>
          <Field label="Name"><Input value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} required /></Field>
          <Field label="Email"><Input type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} autoComplete="off" required /></Field>
          <Field label="Initial password" hint="At least 8 characters."><Input type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} autoComplete="new-password" required /></Field>
          <div className="sm:col-span-3"><ErrorText>{addErr}</ErrorText><Button type="submit" variant="primary">Add user</Button></div>
        </form>
      </Card>

      <Card title="Change my password">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); const r = await mutate("POST", "/auth/password", pw, { ok: "Password changed. Other sessions were signed out.", silentError: true }); setPwErr(r.error); if (!r.error) setPw({ current: "", next: "" }); }}>
          <Field label="Current password"><Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" required /></Field>
          <Field label="New password"><Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" required /></Field>
          <div className="sm:col-span-2"><ErrorText>{pwErr}</ErrorText><Button type="submit">Change password</Button></div>
        </form>
      </Card>
    </div>
  );
}

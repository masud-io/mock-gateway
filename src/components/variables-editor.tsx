"use client";

import { useState } from "react";
import type { Variable } from "@/lib/api";
import { api } from "@/lib/api";
import { useMutate, useToast } from "./providers";
import { Badge, Button, Empty, Input, omitKey } from "./ui";

/** Variables for one scope. Usable in templates as {{vars.key}}. Secret values stay hidden until revealed. */
export function VariablesEditor({ scope, scopeId, variables }: { scope: "client" | "project" | "collection"; scopeId: string; variables: Variable[] }) {
  const mutate = useMutate();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  return (
    <div className="space-y-3">
      {variables.length === 0 ? (
        <Empty>No variables. Define values (base URLs, IDs, tokens) here and use them in responses as <code>{"{{vars.name}}"}</code>.</Empty>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {variables.map((v) => (
              <tr key={v.id} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1.5 pr-3 font-mono text-xs">{v.key}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">
                  {v.isSecret ? (revealed[v.id] ?? "••••••••") : v.value}
                  {v.isSecret && <Badge tone="amber" className="ml-2">secret</Badge>}
                </td>
                <td className="py-1.5 text-right">
                  {v.isSecret && (
                    <Button small variant="ghost" onClick={async () => {
                      if (revealed[v.id]) return setRevealed((r) => omitKey(r, v.id) as Record<string, string>);
                      try { setRevealed((r) => ({ ...r, [v.id]: "" })); const { value } = await api<{ value: string }>("GET", `/variables/${v.id}/reveal`); setRevealed((r) => ({ ...r, [v.id]: value })); }
                      catch { toast("Couldn't reveal the value", "error"); }
                    }}>{revealed[v.id] ? "Hide" : "Reveal"}</Button>
                  )}
                  <Button small variant="ghost" onClick={() => mutate("DELETE", `/variables/${v.id}`, undefined, { ok: "Variable removed" })}>Delete</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const { error } = await mutate("PUT", "/variables", { scope, scopeId, key: key.trim(), value, isSecret: secret }, { ok: "Variable saved" });
          if (!error) { setKey(""); setValue(""); setSecret(false); }
        }}
      >
        <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="name" aria-label="Variable name" className="w-40 font-mono" required />
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" aria-label="Variable value" type={secret ? "password" : "text"} className="w-56 font-mono" />
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> secret</label>
        <Button type="submit" variant="primary" disabled={!key.trim()}>Add / update</Button>
      </form>
    </div>
  );
}

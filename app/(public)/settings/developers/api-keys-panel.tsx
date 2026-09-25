"use client";

import { useState, useTransition } from "react";
import { Check, Copy, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dateTime } from "@/lib/format";
import { createKeyAction, revokeKeyAction, rotateKeyAction, type NewKey } from "./actions";

export type KeyRow = { id: string; name: string; start: string; createdAt: number; lastUsedAt: number | null };

// The secret is shown exactly once, right after it is created or rotated.
export function ApiKeysPanel({ keys }: { keys: KeyRow[] }) {
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<{ id: string; kind: "revoke" | "rotate" } | null>(null);
  const [pending, start] = useTransition();

  function showNew(res: NewKey) {
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setFresh({ name: res.name, key: res.key });
    setCopied(false);
  }

  const create = () =>
    start(async () => {
      const res = await createKeyAction(name);
      showNew(res);
      if (res.ok) setName("");
    });

  const revoke = (id: string) =>
    start(async () => {
      setConfirm(null);
      const res = await revokeKeyAction(id);
      if (res.error) toast.error(res.error);
      else toast.success("Key revoked. Agents using it are locked out now.");
    });

  const rotate = (id: string) =>
    start(async () => {
      setConfirm(null);
      const res = await rotateKeyAction(id);
      showNew(res);
      if (res.ok) toast.success("Key rotated. The old secret stopped working.");
    });

  return (
    <div className="space-y-3">
      {fresh && (
        <div className="rounded-md border border-amber-300 bg-amber-50/70 p-4 dark:border-amber-900 dark:bg-amber-950/30" data-testid="new-key">
          <p className="text-[13px] font-medium">Copy “{fresh.name}” now — it will not be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 truncate rounded border border-border bg-background px-2 py-1.5 font-mono text-[12px]" data-testid="new-key-value">
              {fresh.key}
            </code>
            <Button
              size="sm"
              variant="outline"
              aria-label="Copy key"
              onClick={async () => {
                await navigator.clipboard.writeText(fresh.key);
                setCopied(true);
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setFresh(null)}>
            Done, I saved it
          </Button>
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <Input aria-label="Key name" placeholder="Key name, e.g. “Claude Code”" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" disabled={pending || !name.trim()}>
          <Plus className="h-3.5 w-3.5" />
          Create key
        </Button>
      </form>

      <div className="surface divide-y divide-border">
        {keys.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No API keys yet.</p>}
        {keys.map((k) => (
          <div key={k.id} className="flex items-center gap-3 px-4 py-3" data-testid="key-row">
            <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{k.name}</div>
              <div className="text-[12px] text-muted-foreground">
                <span className="font-mono">{k.start}…</span> · created <span className="font-mono tabular-nums">{dateTime(k.createdAt)}</span> ·{" "}
                {k.lastUsedAt ? (
                  <>
                    last used <span className="font-mono tabular-nums">{dateTime(k.lastUsedAt)}</span>
                  </>
                ) : (
                  "never used"
                )}
              </div>
            </div>
            {confirm?.id === k.id ? (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={confirm.kind === "revoke" ? "destructive" : "default"}
                  disabled={pending}
                  onClick={() => (confirm.kind === "revoke" ? revoke(k.id) : rotate(k.id))}
                >
                  {confirm.kind === "revoke" ? "Revoke" : "Rotate — old key stops working"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" title="Rotate" aria-label={`Rotate ${k.name}`} onClick={() => setConfirm({ id: k.id, kind: "rotate" })}>
                  <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
                <Button size="sm" variant="ghost" title="Revoke" aria-label={`Revoke ${k.name}`} onClick={() => setConfirm({ id: k.id, kind: "revoke" })}>
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

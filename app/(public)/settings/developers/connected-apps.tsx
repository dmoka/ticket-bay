"use client";

import { useTransition } from "react";
import { Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dateTime } from "@/lib/format";
import { disconnectAppAction } from "./actions";

export type AppRow = { id: string; clientId: string; scopes: string[]; createdAt: number };

function label(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

/** Apps connected with OAuth ("Connect" in a chat app). Disconnect = the grant is gone. */
export function ConnectedApps({ apps }: { apps: AppRow[] }) {
  const [pending, start] = useTransition();
  return (
    <div className="surface divide-y divide-border">
      {apps.length === 0 && (
        <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No connected apps. Apps you approve with a Connect button show up here.</p>
      )}
      {apps.map((a) => (
        <div key={a.id} className="flex items-center gap-3 px-4 py-3">
          <Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[13px]">{label(a.clientId)}</div>
            <div className="text-[12px] text-muted-foreground">
              {a.scopes.join(" ")} · connected <span className="font-mono tabular-nums">{dateTime(a.createdAt)}</span>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await disconnectAppAction(a.id);
                if (res.error) toast.error(res.error);
                else toast.success("App disconnected.");
              })
            }
          >
            Disconnect
          </Button>
        </div>
      ))}
    </div>
  );
}

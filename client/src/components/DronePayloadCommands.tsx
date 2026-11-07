import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Send, Loader2, Boxes } from "lucide-react";

// Mirrors the server CapabilityManifest (server/droneStreamProtocol.ts).
type Param = {
  name: string;
  type: "number" | "string" | "boolean" | "enum";
  label?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  default?: unknown;
};
type Command = { action: string; label?: string; description?: string; params: Param[] };
type Payload = { id: string; name?: string; commands: Command[] };
type Manifest = { payloads: Payload[] };

/**
 * Renders a drone's advertised capability manifest as typed command forms.
 * Sending is gated on holding the control lease (B-next, on top of Phase B2).
 */
export function DronePayloadCommands({
  droneId,
  haveControl,
}: {
  droneId: string;
  haveControl: boolean;
}) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  // Param values keyed by `${payloadId}:${action}:${paramName}`.
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);

  const { data } = trpc.drones.capabilities.useQuery(
    { droneId },
    { enabled: !!droneId, refetchInterval: 10000 }
  );
  useEffect(() => {
    if (data?.manifest) setManifest(data.manifest as Manifest);
  }, [data]);

  // Live manifest updates (payload hot-swap) over Socket.IO.
  useEffect(() => {
    if (!droneId) return;
    const socket = io({ path: "/socket.io/", transports: ["websocket"] });
    socket.on("connect", () => socket.emit("subscribe_capabilities", droneId));
    socket.on("capabilities", (msg: { droneId: string; manifest: Manifest }) => {
      if (msg.droneId === droneId) setManifest(msg.manifest);
    });
    return () => {
      socket.emit("unsubscribe_capabilities", droneId);
      socket.disconnect();
    };
  }, [droneId]);

  const sendCommand = trpc.drones.sendCommand.useMutation();

  const key = (payloadId: string, action: string, name: string) => `${payloadId}:${action}:${name}`;

  const coerce = (param: Param, raw: string | undefined): unknown => {
    if (param.type === "number") return raw === undefined || raw === "" ? undefined : Number(raw);
    if (param.type === "boolean") return raw === "true";
    return raw;
  };

  const runCommand = async (payload: Payload, cmd: Command) => {
    const params: Record<string, unknown> = {};
    for (const p of cmd.params) {
      const v = coerce(p, values[key(payload.id, cmd.action, p.name)]);
      if (v === undefined) {
        if (p.required) {
          toast.error(`"${p.label ?? p.name}" is required`);
          return;
        }
        continue;
      }
      params[p.name] = v;
    }
    const id = `${payload.id}:${cmd.action}`;
    setPending(id);
    try {
      const res = await sendCommand.mutateAsync({ droneId, action: cmd.action, params });
      if (res.result.ok) toast.success(`${cmd.label ?? cmd.action} accepted`);
      else toast.error(`${cmd.label ?? cmd.action} rejected: ${res.result.error ?? "unknown"}`);
    } catch (e: any) {
      toast.error(`Command failed: ${e?.message ?? "unknown"}`);
    } finally {
      setPending(null);
    }
  };

  const totalCommands = useMemo(
    () => (manifest?.payloads ?? []).reduce((n, p) => n + p.commands.length, 0),
    [manifest]
  );

  if (!manifest || manifest.payloads.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No capability manifest advertised by this drone yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Boxes className="w-4 h-4 text-primary" />
        Payload commands
        <span className="text-xs text-muted-foreground font-normal">
          ({manifest.payloads.length} payload{manifest.payloads.length === 1 ? "" : "s"}, {totalCommands} command
          {totalCommands === 1 ? "" : "s"})
        </span>
      </div>

      {!haveControl && (
        <p className="text-xs text-muted-foreground">
          Acquire control to send commands. Inputs are read-only until then.
        </p>
      )}

      {manifest.payloads.map((payload) => (
        <div key={payload.id} className="rounded-lg border bg-muted/30 p-3 space-y-3">
          <div className="text-sm font-medium">{payload.name ?? payload.id}</div>
          {payload.commands.map((cmd) => {
            const id = `${payload.id}:${cmd.action}`;
            return (
              <div key={cmd.action} className="flex flex-wrap items-end gap-3 border-t pt-3 first:border-t-0 first:pt-0">
                <div className="min-w-[8rem]">
                  <div className="text-sm">{cmd.label ?? cmd.action}</div>
                  {cmd.description && (
                    <div className="text-xs text-muted-foreground">{cmd.description}</div>
                  )}
                </div>
                {cmd.params.map((p) => {
                  const k = key(payload.id, cmd.action, p.name);
                  const val = values[k] ?? "";
                  const setVal = (v: string) => setValues((prev) => ({ ...prev, [k]: v }));
                  return (
                    <div key={p.name} className="space-y-1">
                      <Label className="text-xs">
                        {p.label ?? p.name}
                        {p.required && <span className="text-destructive"> *</span>}
                      </Label>
                      {p.type === "enum" ? (
                        <Select value={val} onValueChange={setVal} disabled={!haveControl}>
                          <SelectTrigger className="h-8 w-36">
                            <SelectValue placeholder="Select…" />
                          </SelectTrigger>
                          <SelectContent>
                            {(p.options ?? []).map((opt) => (
                              <SelectItem key={opt} value={opt}>
                                {opt}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : p.type === "boolean" ? (
                        <Select value={val} onValueChange={setVal} disabled={!haveControl}>
                          <SelectTrigger className="h-8 w-28">
                            <SelectValue placeholder="—" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">true</SelectItem>
                            <SelectItem value="false">false</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          className="h-8 w-32"
                          type={p.type === "number" ? "number" : "text"}
                          min={p.min}
                          max={p.max}
                          step={p.step}
                          value={val}
                          onChange={(e) => setVal(e.target.value)}
                          disabled={!haveControl}
                        />
                      )}
                    </div>
                  );
                })}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!haveControl || pending === id}
                  onClick={() => runCommand(payload, cmd)}
                >
                  {pending === id ? (
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-1.5" />
                  )}
                  Send
                </Button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

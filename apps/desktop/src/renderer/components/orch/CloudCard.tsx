/**
 * This computer's connection to a Run Coordinator.
 *
 * Two things this screen is careful about, because getting either wrong would
 * be worse than the feature not existing:
 *
 *  - the device token is written here and never read back. Once stored it is
 *    encrypted by the system's own secret store, and nothing in the interface
 *    can show it again - so a screenshot of this screen is not a credential;
 *  - *connected* and *reachable* are shown apart. A coordinator that cannot be
 *    reached has not lost anyone's work: the run is still going there, and the
 *    sentence a person sees says so instead of "falhou".
 */

import { useState } from "react";
import { Cloud, CloudOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, messageOf } from "@/lib/api";
import { SectionLabel } from "./primitives";
import type { CloudStatusView } from "@shared/ipc-contract";

export function CloudCard({
  status,
  onChanged,
}: {
  status: CloudStatusView | null;
  onChanged: () => void;
}) {
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy("connect");
    setError(null);
    try {
      await api.cloud.connect({ endpoint: endpoint.trim(), token: token.trim() });
      // Cleared immediately: the token has been stored, and there is no reason
      // for it to stay in a text field where the next screenshot will catch it.
      setToken("");
      setEndpoint("");
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setError(null);
    try {
      await api.cloud.disconnect();
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-border p-4" data-testid="cloud-card">
      <div className="flex items-center gap-2">
        {status?.configured ? (
          <Cloud className={status.reachable ? "size-4 text-primary" : "size-4 text-muted-foreground"} />
        ) : (
          <CloudOff className="size-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium text-foreground">Nuvem</span>
        <span
          className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
          data-testid="cloud-status"
        >
          {!status?.configured ? "não conectado" : status.reachable ? "conectado" : "sem conexão"}
        </span>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Com a nuvem conectada, um projeto pode rodar em um ambiente isolado no servidor: nada é
        baixado para este computador, e o trabalho continua com o aplicativo fechado.
      </p>

      {status?.configured ? (
        <div className="mt-3 space-y-2">
          <p className="font-mono text-xs text-foreground/85">{status.endpoint}</p>
          {status.problem && <p className="text-xs text-muted-foreground">{status.problem}</p>}
          <p className="text-[11px] text-muted-foreground">
            Desconectar afeta apenas este computador: execuções já enviadas continuam na nuvem e o
            histórico permanece. Para parar uma execução, cancele-a.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void disconnect()}
            data-testid="cloud-disconnect"
          >
            {busy === "disconnect" && <Loader2 className="size-3.5 animate-spin" />} Desconectar
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <SectionLabel>Coordenador</SectionLabel>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://…"
            data-testid="cloud-endpoint"
          />
          <SectionLabel>Token deste dispositivo</SectionLabel>
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder="orq_…"
            data-testid="cloud-token"
          />
          <p className="text-[11px] text-muted-foreground">
            O token é guardado com a proteção do sistema e não pode ser lido de volta aqui.
          </p>
          <Button
            size="sm"
            className="w-full"
            disabled={!endpoint.trim() || !token.trim() || busy !== null}
            onClick={() => void connect()}
            data-testid="cloud-connect"
          >
            {busy === "connect" && <Loader2 className="size-3.5 animate-spin" />} Conectar
          </Button>
        </div>
      )}

      {status && !status.configured && status.problem && (
        <p className="mt-2 text-xs text-muted-foreground">{status.problem}</p>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, messageOf } from "@/lib/api";
import { ProviderIcon } from "./primitives";
import { LoginDialog } from "./dialogs";
import type { GitHubStatusView } from "@shared/ipc-contract";

/** The id the main process reports GitHub sign-in progress under. */
export const GITHUB_ACCOUNT_ID = "github";

/**
 * The GitHub login, as one card: the Client ID of the person's own GitHub
 * App, then Connect, then who is signed in.
 *
 * Registering the app is the one step the product cannot do for the person;
 * the card says exactly what to register so it is a two-minute job. The
 * token never reaches this component - the status does.
 */
export function GitHubCard({
  status,
  onChanged,
  compact = false,
}: {
  status: GitHubStatusView | null;
  onChanged: () => void;
  compact?: boolean;
}) {
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState<"save" | "connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    setClientId(status?.clientId ?? "");
  }, [status?.clientId]);

  const saveClientId = async () => {
    setBusy("save");
    setError(null);
    try {
      await api.github.configure({ clientId: clientId.trim() });
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = () => {
    setError(null);
    setLogin(true);
    setBusy("connect");
    void api.github
      .connect()
      .then(() => onChanged())
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(null));
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setError(null);
    try {
      await api.github.disconnect();
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  const connected = status?.connected ?? false;
  const configured = status?.configured ?? false;

  return (
    <div className="rounded-lg border border-border bg-surface p-4" data-testid="github-card">
      <div className="flex items-center gap-2">
        <ProviderIcon provider="github" />
        <span className="text-sm font-semibold">GitHub</span>
        <span
          className={`ml-auto inline-flex items-center gap-1 text-xs ${connected ? "text-success" : "text-muted-foreground"}`}
          data-testid="github-status"
        >
          {connected ? (
            <>
              <Check className="size-3" /> Conectado como {status?.login}
            </>
          ) : configured ? (
            "Não conectado"
          ) : (
            "Não configurado"
          )}
        </span>
      </div>

      {connected && status && (
        <div className="mt-3 flex items-center gap-3">
          {status.avatarUrl && (
            <img
              src={status.avatarUrl}
              alt=""
              className="size-9 rounded-full border border-border bg-muted"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="min-w-0">
            <div className="truncate text-sm">{status.name || status.login}</div>
            <div className="truncate text-xs text-muted-foreground">@{status.login}</div>
          </div>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={connect} disabled={busy !== null}>
              Reconectar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void disconnect()}
              disabled={busy !== null}
              data-testid="github-disconnect"
            >
              {busy === "disconnect" && <Loader2 className="size-3.5 animate-spin" />} Desconectar
            </Button>
          </div>
        </div>
      )}

      {!connected && (
        <div className="mt-3 space-y-3">
          {!compact && (
            <p className="text-xs text-muted-foreground">
              O login usa o fluxo de dispositivo do GitHub com um GitHub App seu. Só o Client ID é
              necessário; nenhum segredo fica no aplicativo.{" "}
              <button
                onClick={() => setShowHelp((v) => !v)}
                className="text-primary hover:underline"
                data-testid="github-help"
              >
                {showHelp ? "Ocultar passos" : "Como registrar o app"}
              </button>
            </p>
          )}
          {showHelp && (
            <ol className="list-decimal space-y-1 rounded-md border border-border bg-surface-raised p-3 pl-6 text-xs text-muted-foreground">
              <li>
                GitHub → Settings → Developer settings → <strong>GitHub Apps</strong> → New GitHub
                App.
              </li>
              <li>
                Nome: <span className="font-mono">AI Orchestrator</span>. Homepage URL: qualquer
                página sua (por exemplo o repositório do projeto).
              </li>
              <li>
                Marque <strong>Enable Device Flow</strong>. Callback URL e Webhook não são
                necessários (desmarque "Active" em Webhook).
              </li>
              <li>
                Permissões de repositório: <strong>Contents: Read and write</strong>,{" "}
                <strong>Pull requests: Read and write</strong>, <strong>Metadata: Read</strong>,{" "}
                <strong>Checks: Read</strong>. Permissões de conta: <strong>Email addresses: Read</strong>.
              </li>
              <li>
                Depois de criar, <strong>instale o app</strong> na sua conta (e nas organizações
                cujos repositórios privados você quer ver) e copie o <strong>Client ID</strong>.
              </li>
            </ol>
          )}
          <div className="flex gap-2">
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Client ID do GitHub App (ex.: Iv1.abc123...)"
              className="h-8 font-mono text-xs"
              data-testid="github-client-id"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void saveClientId()}
              disabled={busy !== null || clientId.trim().length < 4 || clientId.trim() === status?.clientId}
              data-testid="github-save-client-id"
            >
              {busy === "save" && <Loader2 className="size-3.5 animate-spin" />} Salvar
            </Button>
          </div>
          {status && !status.storageAvailable && (
            <p className="text-xs text-attention">
              Este sistema não oferece armazenamento protegido para credenciais; o login do GitHub
              não pode ser guardado aqui.
            </p>
          )}
          <Button
            size="sm"
            onClick={connect}
            disabled={busy !== null || !configured || !(status?.storageAvailable ?? false)}
            data-testid="github-connect"
          >
            {busy === "connect" && <Loader2 className="size-3.5 animate-spin" />}
            <ExternalLink className="size-3.5" /> Conectar ao GitHub
          </Button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      <LoginDialog
        open={login}
        onOpenChange={(v) => {
          if (!v) {
            setLogin(false);
            onChanged();
          }
        }}
        provider="GitHub"
        accountId={GITHUB_ACCOUNT_ID}
        onRetry={connect}
        onCancel={() => void api.github.cancelConnect()}
        onOpenExternal={(url) => void api.app.openExternal({ url })}
      />
    </div>
  );
}

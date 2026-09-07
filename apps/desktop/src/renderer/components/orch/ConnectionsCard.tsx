import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, messageOf } from "@/lib/api";
import { ProviderIcon } from "./primitives";
import type { ConnectionView } from "@shared/ipc-contract";

/**
 * Connections: the identities the orchestrator and the workers run as.
 *
 * Two kinds sit in one list, because to a person they are one idea - "which
 * account is this agent?" - and separating them into two screens would make
 * the cheap path look like the exotic one:
 *
 *  - **CLI**: the vendor's official tool, signed in through the tool's own
 *    flow. Runs on the subscription the person already pays for. This is the
 *    default and it is listed first.
 *  - **API**: the vendor's HTTP API with a key the person pastes. Billed
 *    separately, and switched off until they say otherwise.
 *
 * The key never reaches this component. `addApi` and `replaceKey` send one
 * in; nothing sends one back. What is rendered is `keyHint` - four characters,
 * which cannot call anything.
 */
export function ConnectionsCard({ onChanged }: { onChanged?: () => void }) {
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [adding, setAdding] = useState<"openai" | "anthropic" | null>(null);
  const [replacing, setReplacing] = useState<ConnectionView | null>(null);
  const [renaming, setRenaming] = useState<ConnectionView | null>(null);
  const [enabling, setEnabling] = useState<ConnectionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    void api.connections
      .list()
      .then((rows) => setConnections([...rows]))
      .catch((e: unknown) => setError(messageOf(e)));
  };

  useEffect(reload, []);
  // The main process says when a connection changed; re-reading through IPC
  // rather than trusting the event's payload is what keeps credentials off
  // the event bus entirely.
  useEffect(() => api.events.connectionsChanged(() => reload()), []);

  const changed = () => {
    reload();
    onChanged?.();
  };

  if (!connections) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Carregando conexões…
      </div>
    );
  }

  // The subscription connections first: they are the ones that cost nothing
  // extra, and a person scanning this list should meet them before the ones
  // that bill.
  const cli = connections.filter((c) => c.connectionKind === "cli");
  const apiConnections = connections.filter((c) => c.connectionKind === "api");

  return (
    <div className="space-y-4">
      {error && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      )}

      {cli.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Conexões pela ferramenta oficial do provider, com o login que você já fez.
            Usam a sua assinatura e <strong className="text-foreground/85">não geram
            cobrança adicional</strong>.
          </p>
          {cli.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} onChanged={changed} />
          ))}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Conexões por chave de API. A cobrança é{" "}
          <strong className="text-foreground/85">separada da sua assinatura</strong> e feita
          pelo provider, por uso.
        </p>
        {apiConnections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            onChanged={changed}
            onReplaceKey={() => setReplacing(connection)}
            onRename={() => setRenaming(connection)}
            onAskEnable={() => setEnabling(connection)}
          />
        ))}
        <div className="flex flex-wrap gap-2">
          <AddButton
            testid="add-connection-openai"
            label="Adicionar conexão OpenAI"
            onClick={() => setAdding("openai")}
          />
          <AddButton
            testid="add-connection-anthropic"
            label="Adicionar conexão Anthropic"
            onClick={() => setAdding("anthropic")}
          />
        </div>
      </div>

      {adding && (
        <AddApiDialog
          provider={adding}
          onClose={() => setAdding(null)}
          onAdded={() => {
            setAdding(null);
            changed();
          }}
        />
      )}
      {replacing && (
        <ReplaceKeyDialog
          connection={replacing}
          onClose={() => setReplacing(null)}
          onDone={() => {
            setReplacing(null);
            changed();
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          connection={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            changed();
          }}
        />
      )}
      {enabling && (
        <EnableBillingDialog
          connection={enabling}
          onClose={() => setEnabling(null)}
          onConfirmed={() => {
            setEnabling(null);
            changed();
          }}
        />
      )}
    </div>
  );
}

/** One connection: who it is, what it costs, and what can be done to it. */
function ConnectionRow({
  connection,
  onChanged,
  onReplaceKey,
  onRename,
  onAskEnable,
}: {
  connection: ConnectionView;
  onChanged: () => void;
  onReplaceKey?: () => void;
  onRename?: () => void;
  onAskEnable?: () => void;
}) {
  const [busy, setBusy] = useState<"test" | "toggle" | "disconnect" | null>(null);
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<Array<{ id: string; displayName: string }> | null>(null);

  const isApi = connection.connectionKind === "api";

  const test = async () => {
    setBusy("test");
    setTested(null);
    try {
      const status = await api.connections.test({ connectionId: connection.id });
      setTested({
        ok: status.authenticated,
        text: status.authenticated
          ? "Conexão funcionando."
          : (status.problem ?? "Não foi possível verificar."),
      });
      onChanged();
    } catch (e) {
      setTested({ ok: false, text: messageOf(e) });
    } finally {
      setBusy(null);
    }
  };

  const loadModels = async () => {
    try {
      setModels([...(await api.connections.models({ connectionId: connection.id }))]);
    } catch (e) {
      setTested({ ok: false, text: messageOf(e) });
    }
  };

  const setEnabled = async (enabled: boolean) => {
    setBusy("toggle");
    try {
      await api.connections.setEnabled({ connectionId: connection.id, enabled });
      onChanged();
    } catch (e) {
      setTested({ ok: false, text: messageOf(e) });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    try {
      await api.connections.disconnect({ connectionId: connection.id });
      onChanged();
    } catch (e) {
      setTested({ ok: false, text: messageOf(e) });
    } finally {
      setBusy(null);
    }
  };

  const chooseModel = async (model: string | null) => {
    try {
      await api.connections.setPreferences({
        connectionId: connection.id,
        model,
        reasoning: connection.defaultReasoning,
      });
      onChanged();
    } catch (e) {
      setTested({ ok: false, text: messageOf(e) });
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-4" data-testid={`connection-${connection.id}`}>
      <div className="flex items-start gap-3">
        <ProviderIcon provider={connection.providerId === "openai" ? "openai" : "anthropic"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{connection.displayName}</span>
            <Badge>{isApi ? "API" : "Ferramenta oficial"}</Badge>
            {isApi ? (
              <Badge tone="warn">Cobrança separada</Badge>
            ) : (
              <Badge tone="ok">Assinatura</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {connection.providerId === "openai" ? "OpenAI" : "Anthropic"}
            {isApi && connection.keyHint ? ` · chave ${connection.keyHint}` : ""}
            {isApi && !connection.hasCredential ? " · sem chave salva" : ""}
            {!isApi
              ? connection.authState === "connected"
                ? " · conectada"
                : " · não conectada"
              : ""}
            {connection.defaultModel ? ` · modelo ${connection.defaultModel}` : ""}
          </p>

          {isApi && (
            <div className="mt-3 flex items-center gap-2">
              <Switch
                data-testid={`connection-enable-${connection.id}`}
                checked={connection.apiEnabled}
                disabled={busy === "toggle" || !connection.hasCredential}
                onCheckedChange={(next: boolean) => {
                  // Turning it ON is the moment money becomes possible, so it
                  // is confirmed. Turning it OFF never needs a dialog.
                  if (next) onAskEnable?.();
                  else void setEnabled(false);
                }}
              />
              <span className="text-xs text-muted-foreground">
                {connection.apiEnabled
                  ? "Habilitada: esta conexão pode fazer chamadas cobradas."
                  : "Desabilitada: nenhuma chamada é feita por esta conexão."}
              </span>
            </div>
          )}

          {tested && (
            <p
              className={
                tested.ok
                  ? "mt-2 flex items-center gap-1.5 text-xs text-emerald-600"
                  : "mt-2 flex items-start gap-1.5 text-xs text-destructive"
              }
            >
              {tested.ok ? (
                <Check className="size-3.5" />
              ) : (
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              )}
              {tested.text}
            </p>
          )}

          {models && (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground">
                Modelos que esta conta realmente tem, perguntados ao provider:
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <ModelChip
                  label="Padrão do provider"
                  active={!connection.defaultModel}
                  onClick={() => void chooseModel(null)}
                />
                {models.map((model) => (
                  <ModelChip
                    key={model.id}
                    label={model.displayName}
                    active={connection.defaultModel === model.id}
                    onClick={() => void chooseModel(model.id)}
                  />
                ))}
                {models.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    O provider não listou nenhum modelo para esta conta.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            data-testid={`connection-test-${connection.id}`}
            onClick={() => void test()}
          >
            {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : "Testar"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="Mais ações">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void loadModels()}>
                Ver modelos disponíveis
              </DropdownMenuItem>
              {isApi && onRename && (
                <DropdownMenuItem onSelect={() => onRename()}>Renomear</DropdownMenuItem>
              )}
              {isApi && onReplaceKey && (
                <DropdownMenuItem onSelect={() => onReplaceKey()}>
                  Substituir chave
                </DropdownMenuItem>
              )}
              {connection.hasCredential && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => void disconnect()}
                    className="text-destructive"
                  >
                    Desconectar
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

/**
 * The dialog that stands between a saved key and a bill.
 *
 * Enabling is the moment this application becomes able to spend money, so it
 * says so in the plainest words available, and says what it cannot promise:
 * a limit here stops this application, not the provider.
 */
function EnableBillingDialog({
  connection,
  onClose,
  onConfirmed,
}: {
  connection: ConnectionView;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.connections.setEnabled({ connectionId: connection.id, enabled: true });
      onConfirmed();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Habilitar “{connection.displayName}”?</DialogTitle>
          <DialogDescription>
            Esta conexão usa a API de{" "}
            {connection.providerId === "openai" ? "OpenAI" : "Anthropic"}, com{" "}
            <strong>cobrança por uso, separada da sua assinatura</strong>. Enquanto estiver
            desabilitada, nenhuma chamada é feita por ela.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-xs text-muted-foreground">
          <p>
            Você pode definir um limite de gasto por execução nas configurações do projeto.
            Esse limite <strong className="text-foreground/85">interrompe este
            aplicativo</strong> — ele não é um teto cobrado pelo provider. Um teto financeiro
            de verdade se configura no painel da sua conta {connection.providerId === "openai" ? "OpenAI" : "Anthropic"}.
          </p>
          <p>
            O modo local com as ferramentas oficiais continua funcionando sem esta conexão.
          </p>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={() => void confirm()} disabled={busy} data-testid="connection-enable-confirm">
            {busy ? <Loader2 className="size-4 animate-spin" /> : "Entendi, habilitar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddApiDialog({
  provider,
  onClose,
  onAdded,
}: {
  provider: "openai" | "anthropic";
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.connections.addApi({
        providerId: provider,
        displayName: name.trim(),
        apiKey: key.trim(),
      });
      // Cleared as soon as it has been handed over, so the key does not sit
      // in this component's state a moment longer than it must.
      setKey("");
      onAdded();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Nova conexão {provider === "openai" ? "OpenAI" : "Anthropic"}
          </DialogTitle>
          <DialogDescription>
            A chave é guardada com criptografia neste computador e nunca é exibida de volta.
            A conexão nasce <strong>desabilitada</strong>: salvar a chave não faz nenhuma
            chamada nem gera cobrança.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Nome desta conexão</span>
            <Input
              value={name}
              autoFocus
              placeholder={provider === "openai" ? "OpenAI Trabalho" : "Claude Trabalho 1"}
              data-testid="connection-name"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Chave de API</span>
            <Input
              value={key}
              type="password"
              spellCheck={false}
              autoComplete="off"
              placeholder="cole a chave aqui"
              data-testid="connection-key"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setKey(e.target.value)}
            />
          </label>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || name.trim().length === 0 || key.trim().length === 0}
            data-testid="connection-save"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : "Salvar conexão"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplaceKeyDialog({
  connection,
  onClose,
  onDone,
}: {
  connection: ConnectionView;
  onClose: () => void;
  onDone: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.connections.replaceKey({ connectionId: connection.id, apiKey: key.trim() });
      setKey("");
      onDone();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Substituir a chave de “{connection.displayName}”</DialogTitle>
          <DialogDescription>
            As equipes, os projetos e o histórico que apontam para esta conexão continuam
            como estão. Só a credencial é trocada.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={key}
          type="password"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="cole a nova chave"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setKey(e.target.value)}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={busy || key.trim().length === 0}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : "Substituir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  connection,
  onClose,
  onDone,
}: {
  connection: ConnectionView;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(connection.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.connections.rename({ connectionId: connection.id, displayName: name.trim() });
      onDone();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renomear conexão</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          autoFocus
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={busy || name.trim().length === 0}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : "Renomear"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddButton({
  label,
  onClick,
  testid,
}: {
  label: string;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
    >
      <Plus className="size-4" /> {label}
    </button>
  );
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ok" | "warn";
}) {
  const tones = {
    neutral: "border-border text-muted-foreground",
    ok: "border-emerald-500/40 text-emerald-600",
    warn: "border-amber-500/40 text-amber-600",
  } as const;
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function ModelChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "flex items-center gap-1 rounded border border-foreground/30 bg-foreground/5 px-2 py-0.5 text-[11px]"
          : "rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
      }
    >
      {active && <Check className="size-3" />}
      {label}
    </button>
  );
}

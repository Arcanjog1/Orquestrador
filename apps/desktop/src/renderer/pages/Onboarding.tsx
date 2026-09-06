import { useEffect, useState } from "react";
import { Check, ChevronRight, Folder, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddProjectDialog, LoginDialog } from "@/components/orch/dialogs";
import { TeamForm } from "@/components/orch/TeamForm";
import { ProviderIcon, SectionLabel } from "@/components/orch/primitives";
import { cn } from "@/lib/utils";
import { api, messageOf } from "@/lib/api";
import { Link, useRouter } from "@/router";
import type {
  AccountView,
  DiagnosticView,
  ProviderName,
  RuntimeId,
  RuntimeProgressEvent,
  WorkspaceView,
} from "@shared/ipc-contract";

const steps = ["Bem-vindo", "Componentes", "Agentes", "GitHub", "Projeto", "Equipe"];

/**
 * Onboarding, exactly as approved.
 *
 * Six steps, the same progress bar, the same card, the same spacing. Each step
 * drives the service that actually does the work:
 *   Componentes -> runtime.diagnose / runtime.install, with real progress
 *   Agentes     -> accounts.create + accounts.connect, for both providers
 *   Projeto     -> workspace.selectFolder / workspace.clone
 *   Equipe      -> workspace.setTeam
 * Nothing advances on a simulated success.
 */
export function OnboardingPage({
  diagnostics,
  accounts,
  workspaces,
  workspace,
  reload,
  onSelectWorkspace,
}: {
  diagnostics: DiagnosticView | null;
  accounts: readonly AccountView[];
  workspaces: readonly WorkspaceView[];
  workspace: WorkspaceView | null;
  reload: () => void;
  onSelectWorkspace: (id: string) => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [login, setLogin] = useState<{ provider: string; accountId: string } | null>(null);
  const [names, setNames] = useState<Record<ProviderName, string>>({
    openai: "Codex Trabalho",
    anthropic: "Claude Trabalho",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, RuntimeProgressEvent>>({});
  const [addProject, setAddProject] = useState(false);

  useEffect(
    () => api.events.runtimeProgress((p) => setProgress((prev) => ({ ...prev, [p.runtimeId]: p }))),
    [],
  );

  const runtimes = diagnostics?.runtimes ?? [];
  const openai = accounts.filter((a) => a.provider === "openai");
  const anthropic = accounts.filter((a) => a.provider === "anthropic");

  async function installRuntime(id: RuntimeId) {
    setBusy(id);
    setError(null);
    try {
      const result = await api.runtime.install({ runtimeId: id });
      if (!result.ok) setError(result.message);
      reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function connect(provider: ProviderName, label: string) {
    setError(null);
    setBusy(provider);
    try {
      const existing = accounts.find((a) => a.provider === provider);
      const account =
        existing ??
        (await api.accounts.create({
          provider,
          name: names[provider].trim() || label,
        }));
      setLogin({ provider: label, accountId: account.id });
      await api.accounts.connect({ accountId: account.id });
      reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const ready =
    (diagnostics?.ready ?? false) &&
    accounts.some((a) => a.state === "connected") &&
    workspace !== null &&
    workspace.team.orchestrator.accountId !== null &&
    workspace.team.worker.accountId !== null;

  return (
    <div className="flex min-h-screen justify-center bg-background px-6 py-14">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-2">
          <div className="grid size-7 place-items-center rounded-md bg-primary/15">
            <Sparkles className="size-4 text-primary" />
          </div>
          <span className="text-sm font-semibold">AI Orchestrator</span>
          <Link
            to="/"
            data-testid="skip-onboarding"
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            Pular onboarding
          </Link>
        </div>

        <div className="mt-6 flex gap-1.5">
          {steps.map((s, i) => (
            <div
              key={s}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors",
                i <= step ? "bg-primary" : "bg-muted",
              )}
            />
          ))}
        </div>

        <div className="mt-8 rounded-xl border border-border bg-surface p-6">
          {step === 0 && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Bem-vindo</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Sua equipe de IA para trabalhar em projetos de forma autônoma. Você define
                o objetivo uma vez; o Orchestrator planeja, delega, verifica e corrige até
                provar que terminou.
              </p>
              <Button className="mt-6" data-testid="start" onClick={() => setStep(1)}>
                Começar <ChevronRight className="size-4" />
              </Button>
            </>
          )}

          {step === 1 && (
            <>
              <SectionLabel>Passo 1</SectionLabel>
              <h2 className="mt-1 text-lg font-semibold">Preparando componentes</h2>
              <div className="mt-4 space-y-2">
                {runtimes.map((r) => {
                  const live = progress[r.runtimeId];
                  const installing = busy === r.runtimeId;
                  return (
                    <div
                      key={r.runtimeId}
                      className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm"
                    >
                      {r.ready ? (
                        <Check className="size-3.5 shrink-0 text-success" />
                      ) : installing ? (
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-running" />
                      ) : (
                        <X className="size-3.5 shrink-0 text-attention" />
                      )}
                      <span>{r.displayName}</span>
                      {r.version && (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {r.version}
                        </span>
                      )}
                      {r.ready ? (
                        <span className="ml-auto text-xs text-success">Pronto</span>
                      ) : installing ? (
                        <span className="ml-auto flex items-center gap-2">
                          <span className="truncate text-xs text-running">
                            {live?.label ?? "Preparando…"}
                            {live?.percent !== null && live?.percent !== undefined
                              ? ` ${Math.round(live.percent)}%`
                              : ""}
                          </span>
                          <button
                            onClick={() => void api.runtime.cancelInstall({ runtimeId: r.runtimeId })}
                            className="text-xs text-danger hover:underline"
                          >
                            Cancelar
                          </button>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="ml-auto"
                          disabled={!r.canAutoConfigure || busy !== null}
                          onClick={() => void installRuntime(r.runtimeId)}
                        >
                          Configurar
                        </Button>
                      )}
                    </div>
                  );
                })}
                {runtimes.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Verificando os componentes do sistema…
                  </p>
                )}
              </div>
              {error && <p className="mt-3 text-xs text-danger">{error}</p>}
              <Button className="mt-6" data-testid="continue" onClick={() => setStep(2)}>
                Continuar
              </Button>
            </>
          )}

          {step === 2 && (
            <>
              <SectionLabel>Passo 2</SectionLabel>
              <h2 className="mt-1 text-lg font-semibold">Conecte seus agentes</h2>
              <div className="mt-4 space-y-4">
                <ConnectBlock
                  provider="openai"
                  title="OpenAI / Codex"
                  label="OpenAI"
                  accounts={openai}
                  name={names.openai}
                  onName={(v) => setNames((n) => ({ ...n, openai: v }))}
                  busy={busy === "openai"}
                  onConnect={() => void connect("openai", "OpenAI")}
                />
                <ConnectBlock
                  provider="anthropic"
                  title="Anthropic / Claude"
                  label="Anthropic"
                  accounts={anthropic}
                  name={names.anthropic}
                  onName={(v) => setNames((n) => ({ ...n, anthropic: v }))}
                  busy={busy === "anthropic"}
                  onConnect={() => void connect("anthropic", "Anthropic")}
                />
              </div>
              {error && <p className="mt-3 text-xs text-danger">{error}</p>}
              <Button className="mt-6" onClick={() => setStep(3)}>
                Continuar
              </Button>
            </>
          )}

          {step === 3 && (
            <>
              <SectionLabel>Passo 3</SectionLabel>
              <h2 className="mt-1 text-lg font-semibold">GitHub</h2>
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
                <ProviderIcon provider="github" />
                <span className="text-sm">GitHub</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  Sem login próprio
                </span>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                O Orquestrador não intermedia o GitHub: ele lê o remoto do projeto que você
                escolher, e clonar usa o Git da sua máquina.
              </p>
              <div className="mt-6 flex gap-2">
                <Button onClick={() => setStep(4)}>Continuar</Button>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <SectionLabel>Passo 4</SectionLabel>
              <h2 className="mt-1 text-lg font-semibold">Escolha seu primeiro projeto</h2>
              <div className="mt-4 space-y-3">
                <div className="space-y-1">
                  {workspaces.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => onSelectWorkspace(p.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border bg-surface-raised px-3 py-2 text-left text-sm transition-colors hover:border-primary/40",
                        p.id === workspace?.id ? "border-primary/40" : "border-border",
                      )}
                    >
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                      <span>{p.name}</span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {p.localPath}
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setAddProject(true)}
                  className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Folder className="size-3.5" /> Selecionar pasta ou clonar
                </button>
              </div>
              <Button className="mt-6" onClick={() => setStep(5)}>
                Continuar
              </Button>
            </>
          )}

          {step === 5 && (
            <>
              <SectionLabel>Passo 5</SectionLabel>
              <h2 className="mt-1 text-lg font-semibold">Configure sua equipe</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Cada função usa uma das suas contas. O Codex supervisiona; o Claude Code
                executa.
              </p>
              {workspace ? (
                <div className="mt-4">
                  <TeamForm
                    workspace={workspace}
                    accounts={accounts}
                    submitLabel={`Atribuir a ${workspace.name}`}
                    onSaved={reload}
                  />
                </div>
              ) : (
                <p className="mt-4 text-sm text-attention">
                  Adicione um projeto no passo anterior para montar a equipe dele.
                </p>
              )}
              {error && <p className="mt-3 text-xs text-danger">{error}</p>}
              {ready ? (
                <p className="mt-4 text-sm text-success">Tudo pronto.</p>
              ) : (
                <p className="mt-4 text-sm text-attention">
                  Ainda faltam etapas, mas você já pode abrir o aplicativo.
                </p>
              )}
              <Button className="mt-4" onClick={() => router.navigate("/")}>
                Abrir AI Orchestrator
              </Button>
            </>
          )}
        </div>
      </div>

      <LoginDialog
        open={!!login}
        onOpenChange={(v) => !v && setLogin(null)}
        provider={login?.provider ?? ""}
        accountId={login?.accountId ?? null}
        onRetry={() => {
          if (login) void api.accounts.connect({ accountId: login.accountId }).then(reload);
        }}
        onCancel={() => {
          if (login) void api.accounts.cancelConnect({ accountId: login.accountId });
        }}
        onOpenExternal={(url) => void api.app.openExternal({ url })}
      />
      <AddProjectDialog
        open={addProject}
        onOpenChange={setAddProject}
        onAdded={(id) => {
          reload();
          onSelectWorkspace(id);
        }}
      />
    </div>
  );
}

function ConnectBlock({
  provider,
  title,
  label,
  accounts,
  name,
  onName,
  busy,
  onConnect,
}: {
  provider: "openai" | "anthropic";
  title: string;
  label: string;
  accounts: readonly AccountView[];
  name: string;
  onName: (v: string) => void;
  busy: boolean;
  onConnect: () => void;
}) {
  const connected = accounts.some((a) => a.state === "connected");
  const existing = accounts[0];
  return (
    <div className="space-y-2">
      {!existing && (
        <Input value={name} onChange={(e) => onName(e.target.value)} placeholder={`Nome da conta ${label}`} />
      )}
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2.5">
        <ProviderIcon provider={provider} />
        <span className="text-sm">{existing?.name ?? title}</span>
        {connected ? (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-success">
            <Check className="size-3" /> Conectado
          </span>
        ) : (
          <Button size="sm" variant="secondary" className="ml-auto" disabled={busy} onClick={onConnect}>
            {busy && <Loader2 className="size-3.5 animate-spin" />} Conectar
          </Button>
        )}
      </div>
      {existing && existing.state !== "connected" && (
        <p className="text-xs text-attention">{existing.detail}</p>
      )}
    </div>
  );
}

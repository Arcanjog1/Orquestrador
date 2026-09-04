import { useEffect, useState } from "react";
import { Check, ChevronRight, Folder, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoginDialog } from "@/components/orch/dialogs";
import { ProviderIcon, SectionLabel } from "@/components/orch/primitives";
import { cn } from "@/lib/utils";
import { invoke, subscribe } from "@/lib/bridge";
import { Link, useRouter } from "@/router";
import type { AppStateView, InstallProgressView, RuntimeId } from "@shared/ipc-contract";

const steps = ["Bem-vindo", "Componentes", "Agentes", "GitHub", "Projeto", "Equipe"];

/**
 * Onboarding, exactly as approved.
 *
 * Six steps, the same progress bar, the same card, the same spacing. Each step
 * is wired to the service that actually does the work:
 *   Componentes -> RuntimeManager.diagnose()/install(), with real progress
 *   Agentes     -> ClaudeAccountManager.connect(), driven by the real CLI
 *   Projeto     -> a real folder picker, registered as a workspace
 * Nothing advances on a simulated success.
 */
export function OnboardingPage({
  state,
  reloadState,
}: {
  state: AppStateView | null;
  reloadState: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [login, setLogin] = useState<{ provider: string; accountId: string } | null>(null);
  const [accountName, setAccountName] = useState("Claude Trabalho");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, InstallProgressView>>({});

  useEffect(
    () =>
      subscribe("runtime:progress", (p) =>
        setProgress((prev) => ({ ...prev, [p.runtimeId]: p })),
      ),
    [],
  );

  const runtimes = state?.diagnostics.runtimes ?? [];
  const accounts = state?.accounts ?? [];
  const anthropic = accounts.filter((a) => a.providerId === "anthropic");

  async function installRuntime(id: RuntimeId) {
    setBusy(id);
    setError(null);
    try {
      const result = await invoke("runtime:install", { runtimeId: id });
      if (!result.ok) setError(result.problem ?? "Não foi possível preparar este componente.");
      reloadState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível preparar este componente.");
    } finally {
      setBusy(null);
    }
  }

  async function connectClaude() {
    setError(null);
    setBusy("anthropic");
    try {
      const existing = anthropic[0];
      const account =
        existing ??
        (await invoke("accounts:create", {
          providerId: "anthropic",
          displayName: accountName.trim() || "Claude",
        }));
      setLogin({ provider: "Anthropic", accountId: account.id });
      await invoke("accounts:connect", { accountId: account.id });
      reloadState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível conectar a conta.");
    } finally {
      setBusy(null);
    }
  }

  async function chooseProject() {
    setError(null);
    try {
      await invoke("workspaces:choose", undefined);
      reloadState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível abrir a pasta.");
    }
  }

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
              <Button className="mt-6" onClick={() => setStep(1)}>
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
                  return (
                    <div
                      key={r.runtimeId}
                      className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm"
                    >
                      {r.healthy ? (
                        <Check className="size-3.5 text-success" />
                      ) : busy === r.runtimeId ? (
                        <Loader2 className="size-3.5 animate-spin text-running" />
                      ) : (
                        <X className="size-3.5 text-attention" />
                      )}
                      <span>{r.displayName}</span>
                      {r.version && (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {r.version}
                        </span>
                      )}
                      {r.healthy ? (
                        <span className="ml-auto text-xs text-success">Pronto</span>
                      ) : busy === r.runtimeId ? (
                        <span className="ml-auto truncate text-xs text-running">
                          {live?.message ?? "Preparando…"}
                          {live?.percent !== undefined ? ` ${Math.round(live.percent)}%` : ""}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="ml-auto"
                          disabled={!r.canAutoConfigure || busy !== null}
                          onClick={() => void installRuntime(r.runtimeId)}
                        >
                          {r.remedy ?? "Configurar"}
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
              <Button className="mt-6" onClick={() => setStep(2)}>
                Continuar
              </Button>
            </>
          )}

          {step === 2 && (
            <>
              <SectionLabel>Passo 2</SectionLabel>
              <h2 className="mt-1 text-lg font-semibold">Conecte seus agentes</h2>
              <div className="mt-4 space-y-2">
                {anthropic.length === 0 && (
                  <Input
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    placeholder="Nome desta conta, ex.: Claude Trabalho"
                  />
                )}
                <ConnectRow
                  provider="anthropic"
                  title={anthropic[0]?.displayName ?? "Anthropic / Claude"}
                  connected={anthropic.some((a) => a.state === "connected")}
                  busy={busy === "anthropic"}
                  onConnect={() => void connectClaude()}
                />
                {/* OpenAI has no account manager in this build. Saying so beats
                    offering a button that cannot do anything. */}
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
                  <ProviderIcon provider="openai" />
                  <span className="text-sm">OpenAI / Codex</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    Ainda não gerenciado
                  </span>
                </div>
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
              <div className="mt-4">
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
                  <ProviderIcon provider="github" />
                  <span className="text-sm">GitHub</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    Ainda não gerenciado
                  </span>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  O repositório é lido do remoto do projeto que você escolher no próximo
                  passo.
                </p>
              </div>
              <div className="mt-6 flex gap-2">
                <Button onClick={() => setStep(4)}>Continuar</Button>
                <Button variant="ghost" onClick={() => setStep(4)}>
                  Fazer depois
                </Button>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <SectionLabel>Passo 4</SectionLabel>
              <h2 className="mt-1 text-lg font-semibold">Escolha seu primeiro projeto</h2>
              <div className="mt-4 space-y-3">
                <div className="space-y-1">
                  {(state?.workspaces ?? []).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        void invoke("workspaces:open", { workspaceId: p.id })
                          .then(reloadState)
                          .catch(() => setError("Não foi possível abrir o projeto."));
                      }}
                      className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2 text-left text-sm transition-colors hover:border-primary/40"
                    >
                      <Folder className="size-3.5 text-muted-foreground" />
                      <span>{p.displayName}</span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {p.localPath}
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => void chooseProject()}
                  className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Folder className="size-3.5" /> Selecionar pasta local
                </button>
              </div>
              {error && <p className="mt-3 text-xs text-danger">{error}</p>}
              <Button className="mt-6" onClick={() => setStep(5)}>
                Continuar
              </Button>
            </>
          )}

          {step === 5 && (
            <>
              <SectionLabel>Passo 5</SectionLabel>
              <h2 className="mt-1 text-lg font-semibold">Configure sua equipe</h2>
              <div className="mt-4 space-y-2">
                {(state?.agents ?? []).map((a) => (
                  <div
                    key={a.id}
                    className="rounded-lg border border-border bg-surface-raised p-3"
                  >
                    <div className="flex items-center gap-2">
                      <ProviderIcon
                        provider={a.providerId === "google" ? "gemini" : a.providerId}
                      />
                      <SectionLabel>{a.role}</SectionLabel>
                    </div>
                    <div className="mt-2 text-sm">
                      {a.displayName} · {a.accountName ?? "sem conta"}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">
                      {[a.model, a.reasoning && `raciocínio ${a.reasoning}`]
                        .filter(Boolean)
                        .join(" · ") || "sem modelo definido"}
                    </div>
                  </div>
                ))}
                {(state?.agents ?? []).length === 0 && (
                  <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                    Nenhum agente foi configurado ainda. A equipe é montada quando um
                    provider gerenciável estiver conectado.
                  </div>
                )}
              </div>
              {state?.onboarded ? (
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
        onRetry={() => void connectClaude()}
        onCancel={() => {
          if (login) void invoke("accounts:cancelConnect", { accountId: login.accountId });
        }}
      />
    </div>
  );
}

function ConnectRow({
  provider,
  title,
  connected,
  busy,
  onConnect,
}: {
  provider: "openai" | "anthropic" | "github";
  title: string;
  connected: boolean;
  busy: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2.5">
      <ProviderIcon provider={provider} />
      <span className="text-sm">{title}</span>
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
  );
}

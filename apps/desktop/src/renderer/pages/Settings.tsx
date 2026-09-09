import { AgentsCard } from '@/components/orch/AgentsCard';
import { useEffect, useState } from "react";
import { ArrowLeft, Check, Loader2, MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoginDialog } from "@/components/orch/dialogs";
import { GitHubCard } from "@/components/orch/GitHubCard";
import { CloudCard } from "@/components/orch/CloudCard";
import { ConnectionsCard } from "@/components/orch/ConnectionsCard";
import { ProviderIcon, SectionLabel } from "@/components/orch/primitives";
import { cn } from "@/lib/utils";
import { api, messageOf } from "@/lib/api";
import { applyTheme, THEMES } from "@/lib/theme";
import { Link, useRouter, useSearch } from "@/router";
import { ACCOUNT_CAPABILITY_TIERS, ACCOUNT_REASONING_TIERS } from "@shared/ipc-contract";
import type {
  AccountRoutingView,
  AccountView,
  CloudStatusView,
  GitHubStatusView,
  AppInfo,
  DiagnosticView,
  ProviderName,
  VerificationView,
  WorkspaceView,
} from "@shared/ipc-contract";

const tabs = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "accounts", label: "Accounts & Integrations" },
  { id: "agents", label: "Agentes" },
  { id: "execution", label: "Execution" },
  { id: "verifications", label: "Verificações do projeto" },
  { id: "git", label: "Git" },
  { id: "developer", label: "Developer Mode" },
] as const;

type TabId = (typeof tabs)[number]["id"];

/**
 * Setting keys, so the renderer and the settings table agree on one spelling.
 *
 * Every key here is read by something: the loop (execution.*), the theme
 * (appearance.theme), the push button (git.confirmBeforePush), this screen
 * (developer.mode). The prototype's switches with nothing behind them -
 * auto-run, auto-retry, human-review reasons, density, language, handoff -
 * are gone rather than shown as if they did something.
 */
export const KEY = {
  maxIterations: "execution.maxIterations",
  agentTimeoutMinutes: "execution.agentTimeoutMinutes",
  verificationTimeoutMinutes: "execution.verificationTimeoutMinutes",
  theme: "appearance.theme",
  confirmPush: "git.confirmBeforePush",
  devMode: "developer.mode",
} as const;

/** The loop's own defaults, shown when nothing was set. */
const LOOP_DEFAULTS = { maxIterations: 8, agentTimeoutMinutes: 15, verificationTimeoutMinutes: 10 };

/**
 * Settings, exactly as approved.
 *
 * The 248px rail, the tab list, `max-w-3xl` body, the row layout, the segmented
 * control and the account card are the design's. Every control reads and writes
 * the `settings` table that already existed; the account actions call the real
 * account service, for both providers.
 */
export function SettingsPage({
  accounts,
  github,
  cloud,
  workspace,
  diagnostics,
  appInfo,
  reload,
}: {
  accounts: readonly AccountView[];
  github: GitHubStatusView | null;
  cloud: CloudStatusView | null;
  workspace: WorkspaceView | null;
  diagnostics: DiagnosticView | null;
  appInfo: AppInfo | null;
  reload: () => void;
}) {
  const router = useRouter();
  const search = useSearch<{ tab: TabId }>();
  // The URL is the single source of truth for the active tab, so a deep link
  // from the sidebar and a click on the rail cannot drift apart.
  const active: TabId = tabs.some((t) => t.id === search.tab)
    ? (search.tab as TabId)
    : "accounts";
  const setActive = (tab: TabId) => router.navigate("/configuracoes", { tab });

  const [login, setLogin] = useState<{ provider: string; accountId: string } | null>(null);
  const [removing, setRemoving] = useState<AccountView | null>(null);
  const [adding, setAdding] = useState<ProviderName | null>(null);
  const [newName, setNewName] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.settings
      .all()
      .then((all) => setSettings({ ...all }))
      .catch(() => {});
  }, []);

  const save = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    void api.settings.set({ key, value }).catch((e: unknown) => toast(messageOf(e)));
  };
  const flag = (key: string, fallback: boolean) =>
    settings[key] === undefined ? fallback : settings[key] === "true";

  const fail = (e: unknown) => toast(messageOf(e));

  const openai = accounts.filter((a) => a.provider === "openai");
  const anthropic = accounts.filter((a) => a.provider === "anthropic");
  const devMode = flag(KEY.devMode, false);

  const connect = (account: AccountView) => {
    setLogin({ provider: account.provider === "openai" ? "OpenAI" : "Anthropic", accountId: account.id });
    void api.accounts.connect({ accountId: account.id }).then(reload).catch(fail);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside className="w-[248px] shrink-0 border-r border-sidebar-border bg-sidebar p-3">
        <Link
          to="/"
          className="mb-4 inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Voltar ao workspace
        </Link>
        <SectionLabel>Settings</SectionLabel>
        <div className="mt-2 space-y-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={cn(
                "w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                active === t.id
                  ? "bg-sidebar-accent text-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-10">
          <h1 className="text-xl font-semibold tracking-tight">
            {tabs.find((t) => t.id === active)?.label}
          </h1>

          {active === "agents" && <AgentsCard accounts={accounts} onChanged={reload} />}
          {active === "accounts" && (
            <div className="mt-8 space-y-8">
              <section>
                <SectionLabel>AI Providers</SectionLabel>
                <div className="mt-3 space-y-2">
                  {openai.map((a) => (
                    <AccountCard
                      key={a.id}
                      account={a}
                      onReconnect={() => connect(a)}
                      onRemove={() => setRemoving(a)}
                      onChanged={() => reload()}
                    />
                  ))}
                  <AddAccount
                    label="Adicionar conta OpenAI"
                    onClick={() => {
                      setNewName("");
                      setAdding("openai");
                    }}
                  />
                </div>
                <div className="mt-4 space-y-2">
                  {anthropic.map((a) => (
                    <AccountCard
                      key={a.id}
                      account={a}
                      onReconnect={() => connect(a)}
                      onRemove={() => setRemoving(a)}
                      onChanged={() => reload()}
                    />
                  ))}
                  <AddAccount
                    label="Adicionar conta Anthropic"
                    onClick={() => {
                      setNewName("");
                      setAdding("anthropic");
                    }}
                  />
                </div>
              </section>

              <section className="border-t border-border pt-6">
                <SectionLabel>Conexões</SectionLabel>
                <p className="mt-1 text-xs text-muted-foreground">
                  Cada agente da equipe roda como uma destas conexões. Duas conexões podem
                  ser do mesmo provider com credenciais diferentes — é assim que “Claude
                  Trabalho 1” e “Claude Trabalho 2” coexistem sem misturar contexto.
                </p>
                <div className="mt-3">
                  <ConnectionsCard onChanged={reload} />
                </div>
              </section>

              <section className="border-t border-border pt-6">
                <SectionLabel>Development</SectionLabel>
                <div className="mt-3 space-y-3">
                  <GitHubCard status={github} onChanged={reload} />
                  <CloudCard status={cloud} onChanged={reload} />
                </div>
              </section>

              <p className="text-xs text-muted-foreground">
                <strong className="text-foreground/85">Reconectar</strong> refaz o login
                mantendo o perfil.{" "}
                <strong className="text-foreground/85">Remover</strong> exclui o cadastro e
                a pasta isolada da conta, e exige confirmação.
              </p>
            </div>
          )}

          {active === "verifications" && (
            <VerificationsTab workspace={workspace} />
          )}

          {active === "execution" && (
            <div className="mt-8 space-y-6">
              <p className="text-xs text-muted-foreground">
                Lidos pelo loop no início de cada execução. Uma mudança aqui vale para a próxima
                tarefa enviada, sem reiniciar.
              </p>
              <NumberRow
                label="Máximo de iterações"
                hint="Ao atingir o limite a execução para e pede uma nova instrução"
                value={settings[KEY.maxIterations]}
                fallback={LOOP_DEFAULTS.maxIterations}
                min={1}
                max={50}
                onSave={(n) => save(KEY.maxIterations, String(n))}
                testid="setting-max-iterations"
              />
              <NumberRow
                label="Tempo máximo por agente (min)"
                hint="Quanto o Codex ou o Claude Code podem levar em uma invocação"
                value={settings[KEY.agentTimeoutMinutes]}
                fallback={LOOP_DEFAULTS.agentTimeoutMinutes}
                min={1}
                max={180}
                onSave={(n) => save(KEY.agentTimeoutMinutes, String(n))}
                testid="setting-agent-timeout"
              />
              <NumberRow
                label="Tempo máximo por verificação (min)"
                hint="Quanto um comando de verificação pode levar"
                value={settings[KEY.verificationTimeoutMinutes]}
                fallback={LOOP_DEFAULTS.verificationTimeoutMinutes}
                min={1}
                max={180}
                onSave={(n) => save(KEY.verificationTimeoutMinutes, String(n))}
                testid="setting-verification-timeout"
              />

              <BudgetSection workspace={workspace} onSaved={reload} />
            </div>
          )}

          {active === "appearance" && (
            <div className="mt-8 space-y-6">
              <Row label="Tema" hint="Dark é o padrão do aplicativo; System segue o sistema">
                <Segmented
                  options={[...THEMES]}
                  value={settings[KEY.theme] ?? "Dark"}
                  onChange={(v) => {
                    applyTheme(v);
                    save(KEY.theme, v);
                  }}
                  testid="setting-theme"
                />
              </Row>
            </div>
          )}

          {active === "general" && (
            <div className="mt-8 space-y-6">
              <Row
                label="Iniciar com o sistema"
                hint={
                  appInfo?.startWithSystem === null
                    ? "Este sistema não oferece essa opção ao aplicativo"
                    : "Abre o AI Orchestrator ao entrar no Windows"
                }
              >
                <Switch
                  checked={appInfo?.startWithSystem ?? false}
                  disabled={appInfo?.startWithSystem === null || appInfo === null}
                  onCheckedChange={(v) => {
                    void api.app
                      .setStartWithSystem({ enabled: v })
                      .then(() => reload())
                      .catch(fail);
                  }}
                  data-testid="setting-start-with-system"
                />
              </Row>
              <Row label="Idioma" hint="Português (Brasil). A interface ainda não tem outros idiomas.">
                <span className="text-xs text-muted-foreground">PT-BR</span>
              </Row>
            </div>
          )}

          {active === "git" && (
            <div className="mt-8 space-y-6">
              <Row label="Confirmar antes de push" hint="O botão Push do cabeçalho pede confirmação">
                <Switch
                  checked={flag(KEY.confirmPush, true)}
                  onCheckedChange={(v) => save(KEY.confirmPush, String(v))}
                  data-testid="setting-confirm-push"
                />
              </Row>
              <Row
                label="Remoto do projeto atual"
                hint={workspace?.repositoryUrl ?? "Nenhum remoto registrado para o projeto atual"}
              >
                <span className="text-xs text-muted-foreground">{workspace?.name ?? "—"}</span>
              </Row>
            </div>
          )}

        </div>
      </main>

      <LoginDialog
        open={!!login}
        onOpenChange={(v) => !v && setLogin(null)}
        provider={login?.provider ?? ""}
        accountId={login?.accountId ?? null}
        onRetry={() => {
          if (login) void api.accounts.connect({ accountId: login.accountId }).then(reload).catch(fail);
        }}
        onCancel={() => {
          if (login) void api.accounts.cancelConnect({ accountId: login.accountId });
        }}
        onOpenExternal={(url) => void api.app.openExternal({ url })}
      />

      <Dialog open={adding !== null} onOpenChange={(v) => !v && setAdding(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              Adicionar conta {adding === "openai" ? "OpenAI" : "Anthropic"}
            </DialogTitle>
            <DialogDescription>
              Escolha um nome para identificar esta conta. O aplicativo cuida do resto.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={adding === "openai" ? "Ex.: Codex Trabalho" : "Ex.: Claude Trabalho"}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(null)}>
              Voltar
            </Button>
            <Button
              disabled={!newName.trim()}
              onClick={() => {
                const provider = adding;
                if (!provider) return;
                setAdding(null);
                void api.accounts
                  .create({ provider, name: newName.trim() })
                  .then((account) => {
                    reload();
                    connect(account);
                  })
                  .catch(fail);
              }}
            >
              Criar e conectar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(v) => !v && setRemoving(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Remover {removing?.name}?</DialogTitle>
            <DialogDescription>
              O cadastro e a pasta isolada desta conta serão excluídos do Orquestrador.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Voltar
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (!target) return;
                void api.accounts
                  .remove({ accountId: target.id })
                  .then(() => {
                    reload();
                    toast(`${target.name} removida`);
                  })
                  .catch(fail);
              }}
            >
              Remover conta
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The project's verifications.
 *
 * Configuration, not a console: what a person writes here is stored as a
 * `verification_definition`, and the orchestration loop later asks for it *by
 * id* and runs the stored command. Nothing typed here runs when it is saved,
 * and no agent can reach this screen. The main process screens each command
 * with the same rule the Verifier applies, so a command it would refuse is
 * refused while the person is still looking at it.
 */
function VerificationsTab({ workspace }: { workspace: WorkspaceView | null }) {
  const [items, setItems] = useState<readonly VerificationView[] | null>(null);
  const [editing, setEditing] = useState<{ mode: "create" | "edit"; item: VerificationView | null } | null>(null);
  const [removing, setRemoving] = useState<VerificationView | null>(null);
  const [form, setForm] = useState({ id: "", label: "", command: "" });
  const [saving, setSaving] = useState(false);

  const fail = (e: unknown) => toast(messageOf(e));
  const workspaceId = workspace?.id ?? null;

  const refresh = () => {
    if (!workspaceId) return;
    void api.verifications
      .list({ workspaceId })
      .then((rows) => setItems(rows))
      .catch((e: unknown) => {
        setItems([]);
        fail(e);
      });
  };

  useEffect(refresh, [workspaceId]);

  if (!workspace) {
    return (
      <p className="mt-8 text-sm text-muted-foreground">
        Escolha um projeto para configurar as verificações dele.
      </p>
    );
  }

  const openCreate = () => {
    setForm({ id: "", label: "", command: "" });
    setEditing({ mode: "create", item: null });
  };
  const openEdit = (item: VerificationView) => {
    setForm({ id: item.id, label: item.label, command: item.command });
    setEditing({ mode: "edit", item });
  };

  const submit = () => {
    if (!editing) return;
    setSaving(true);
    const done = () => {
      setSaving(false);
      setEditing(null);
      refresh();
    };
    const failed = (e: unknown) => {
      setSaving(false);
      fail(e);
    };
    if (editing.mode === "create") {
      void api.verifications
        .create({
          workspaceId: workspace.id,
          id: form.id.trim(),
          label: form.label.trim(),
          command: form.command.trim(),
        })
        .then(done)
        .catch(failed);
    } else {
      void api.verifications
        .update({
          workspaceId: workspace.id,
          id: editing.item!.id,
          label: form.label.trim(),
          command: form.command.trim(),
        })
        .then(done)
        .catch(failed);
    }
  };

  const toggle = (item: VerificationView, enabled: boolean) => {
    void api.verifications
      .update({ workspaceId: workspace.id, id: item.id, enabled })
      .then(refresh)
      .catch(fail);
  };

  return (
    <div className="mt-8 space-y-6">
      <p className="text-sm text-muted-foreground">
        O orquestrador pede uma verificação <strong className="text-foreground/85">pelo id</strong>{" "}
        e o aplicativo executa o comando salvo aqui. Um id que não existe, ou que está desativado,
        é recusado — nunca adivinhado.
      </p>

      <button
        data-testid="add-verification"
        onClick={openCreate}
        className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
      >
        <Plus className="size-3.5" /> Adicionar verificação
      </button>

      {items === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Carregando…
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhuma verificação cadastrada neste projeto.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold">{item.id}</span>
                <span
                  className={cn(
                    "ml-auto text-xs",
                    item.enabled ? "text-success" : "text-muted-foreground",
                  )}
                >
                  {item.enabled ? "Ativa" : "Desativada"}
                </span>
                <Switch
                  data-testid={`toggle-${item.id}`}
                  checked={item.enabled}
                  onCheckedChange={(v) => toggle(item, v === true)}
                />
              </div>
              <p className="mt-2 text-sm">{item.label}</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{item.command}</p>
              <div className="mt-3 flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`edit-${item.id}`}
                  onClick={() => openEdit(item)}
                >
                  Editar
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:text-danger"
                  data-testid={`remove-${item.id}`}
                  onClick={() => setRemoving(item)}
                >
                  Remover
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {editing?.mode === "edit" ? `Editar ${editing.item?.id}` : "Adicionar verificação"}
            </DialogTitle>
            <DialogDescription>
              O comando roda na pasta do projeto, sem shell. O aplicativo recusa operadores de
              shell e comandos git destrutivos.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={form.id}
              disabled={editing?.mode === "edit"}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              placeholder="Id, ex.: typecheck"
              data-testid="verification-id"
            />
            <Input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="Nome, ex.: TypeScript typecheck"
              data-testid="verification-label"
            />
            <Input
              value={form.command}
              onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
              placeholder="Comando, ex.: npm run typecheck"
              className="font-mono"
              data-testid="verification-command"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Voltar
            </Button>
            <Button
              data-testid="save-verification"
              disabled={
                saving ||
                !form.label.trim() ||
                !form.command.trim() ||
                (editing?.mode === "create" && !form.id.trim())
              }
              onClick={submit}
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(v) => !v && setRemoving(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Remover {removing?.id}?</DialogTitle>
            <DialogDescription>
              O projeto deixa de oferecer esta verificação ao orquestrador. O histórico dos runs
              anteriores não muda.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Voltar
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (!target) return;
                void api.verifications
                  .remove({ workspaceId: workspace.id, id: target.id })
                  .then(() => {
                    refresh();
                    toast(`${target.id} removida`);
                  })
                  .catch(fail);
              }}
            >
              Remover verificação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Spending limits for this project's metered connections.
 *
 * Empty means no limit, which is what every project has until someone types
 * one - so nothing here changes behaviour by existing.
 *
 * The paragraph under the fields is the important part of this component. A
 * limit set here refuses the application's *next* call; it cannot make a
 * provider refuse one. Saying otherwise would be the most expensive kind of
 * wrong, so it is said plainly, next to the field it is about.
 */
function BudgetSection({
  workspace,
  onSaved,
}: {
  workspace: WorkspaceView | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({ invocations: "", tokens: "", cost: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft({
      invocations: workspace?.budget?.maxInvocations?.toString() ?? "",
      tokens: workspace?.budget?.maxTokens?.toString() ?? "",
      cost: workspace?.budget?.maxCostUsd?.toString() ?? "",
    });
  }, [workspace?.id, workspace?.budget]);

  if (!workspace) {
    return (
      <p className="border-t border-border pt-6 text-xs text-muted-foreground">
        Abra um projeto para configurar os limites de gasto dele.
      </p>
    );
  }

  const parse = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.workspace.setBudget({
        workspaceId: workspace.id,
        maxInvocations: parse(draft.invocations),
        maxTokens: parse(draft.tokens),
        maxCostUsd: parse(draft.cost),
      });
      onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="border-t border-border pt-6" data-testid="budget-section">
      <SectionLabel>Limites de gasto — {workspace.name}</SectionLabel>
      <p className="mt-1 text-xs text-muted-foreground">
        Valem para conexões de API, que têm cobrança por uso. Vazio significa sem limite.
        Chamadas feitas pela ferramenta oficial, na sua assinatura, não entram no limite em
        dólares.
      </p>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">Chamadas por execução</span>
          <Input
            value={draft.invocations}
            inputMode="numeric"
            placeholder="sem limite"
            onChange={(e) => setDraft((p) => ({ ...p, invocations: e.target.value }))}
            data-testid="budget-invocations"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">Tokens por execução</span>
          <Input
            value={draft.tokens}
            inputMode="numeric"
            placeholder="sem limite"
            onChange={(e) => setDraft((p) => ({ ...p, tokens: e.target.value }))}
            data-testid="budget-tokens"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">Gasto por execução (US$)</span>
          <Input
            value={draft.cost}
            inputMode="decimal"
            placeholder="sem limite"
            onChange={(e) => setDraft((p) => ({ ...p, cost: e.target.value }))}
            data-testid="budget-cost"
          />
        </label>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        <strong className="text-foreground/85">Importante:</strong> este limite interrompe o
        aplicativo — ele <strong className="text-foreground/85">não é um teto cobrado pelo
        provider</strong>. Um teto financeiro de verdade se configura no painel da sua conta
        OpenAI ou Anthropic. O gasto mostrado aqui é uma estimativa; quando o provider não
        informa o custo, a execução mostra “não informado”, nunca zero.
      </p>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <Button
        className="mt-3"
        size="sm"
        disabled={saving}
        onClick={() => void submit()}
        data-testid="budget-save"
      >
        {saving ? <Loader2 className="size-4 animate-spin" /> : "Salvar limites"}
      </Button>
    </section>
  );
}

function AccountCard({
  account,
  onReconnect,
  onRemove,
  onChanged,
}: {
  account: AccountView;
  onReconnect: () => void;
  onRemove: () => void;
  onChanged: (updated: AccountView) => void;
}) {
  const connected = account.state === "connected";
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={account.provider === "openai" ? "openai" : "anthropic"} />
        <span className="text-sm font-semibold">{account.name}</span>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1 text-xs",
            connected
              ? "text-success"
              : account.state === "ambient-credential"
                ? "text-attention"
                : "text-muted-foreground",
          )}
        >
          {connected ? (
            <Check className="size-3" />
          ) : (
            <span className="size-2 rounded-full border border-current" />
          )}
          {connected
            ? "Conectado"
            : account.state === "ambient-credential"
              ? "Credencial do ambiente"
              : account.state === "runtime-missing"
                ? "Componente ausente"
                : "Desconectado"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onReconnect}>Reconectar</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onRemove} className="text-danger focus:text-danger">
              Remover
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {account.detail && <p className="mt-2 text-xs text-muted-foreground">{account.detail}</p>}
      <AccountRouting account={account} onChanged={onChanged} />
    </div>
  );
}

/**
 * O teto desta conta.
 *
 * O que aconteceu sem isto: a execução escalou o worker até o topo, o topo
 * significava o modelo premium no esforço máximo, e a conta respondeu
 * *"You're out of usage credits"*. A assinatura não tinha acabado — faltavam
 * os créditos extras que aquele modelo consome, e nada no aplicativo sabia que
 * isso podia ser verdade de uma conta e não de outra.
 *
 * Por isso o teto mora **na conta**. Duas contas Claude podem ter tetos
 * diferentes, e mexer numa não mexe na outra.
 */
function AccountRouting({
  account,
  onChanged,
}: {
  account: AccountView;
  onChanged: (updated: AccountView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Held locally, seeded from the account and reseeded when it changes.
  //
  // Reading straight from the prop loses an edit: saving reloads the accounts,
  // and a second change made before that reload lands would compose against
  // the stale value and quietly undo the first one. Two quick changes have to
  // both survive.
  const [routing, setRouting] = useState<AccountRoutingView>(account.routing);
  useEffect(() => {
    setRouting(account.routing);
  }, [account.routing]);

  async function save(patch: Partial<AccountRoutingView>) {
    const next: AccountRoutingView = { ...routing, ...patch };
    setRouting(next);
    setBusy(true);
    setError(null);
    try {
      onChanged(
        await api.accounts.setRoutingPolicy({
          accountId: account.id,
          maxCapability: next.maxCapability,
          maxReasoning: next.maxReasoning,
          allowPremiumModels: next.allowPremiumModels,
        }),
      );
    } catch (e) {
      // The save failed, so the screen must not keep showing it as done.
      setRouting(account.routing);
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-border/60 pt-3" data-testid={`routing-${account.id}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Roteamento desta conta
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted-foreground">
          Teto de modelo
          <select
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={routing.maxCapability ?? ""}
            disabled={busy}
            data-testid={`routing-capability-${account.id}`}
            onChange={(e) => void save({ maxCapability: e.target.value || null })}
          >
            <option value="">Sem teto</option>
            {ACCOUNT_CAPABILITY_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {CAPABILITY_LABEL[tier]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Teto de raciocínio
          <select
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={routing.maxReasoning ?? ""}
            disabled={busy}
            data-testid={`routing-reasoning-${account.id}`}
            onChange={(e) => void save({ maxReasoning: e.target.value || null })}
          >
            <option value="">Sem teto</option>
            {ACCOUNT_REASONING_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {REASONING_LABEL[tier]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={routing.allowPremiumModels}
          disabled={busy}
          data-testid={`routing-premium-${account.id}`}
          onChange={(e) => void save({ allowPremiumModels: e.target.checked })}
        />
        <span>
          Permitir modelos que exigem créditos extras
          {routing.premiumModels.length > 0 && (
            <> ({routing.premiumModels.join(", ")})</>
          )}
          . Desligado, o roteamento nunca escolhe um deles — nem para tentar.
        </span>
      </label>
      {error && (
        <p className="mt-2 text-xs text-danger" data-testid={`routing-error-${account.id}`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Os níveis, nas palavras que a tela usa. */
const CAPABILITY_LABEL: Record<string, string> = {
  FAST: "Rápido",
  BALANCED: "Equilibrado",
  STRONG: "Forte (Opus)",
  MAX: "Máximo (inclui premium)",
};

const REASONING_LABEL: Record<string, string> = {
  LOW: "Baixo",
  MEDIUM: "Médio",
  HIGH: "Alto",
  MAX: "Máximo",
};

function AddAccount({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
    >
      <Plus className="size-3.5" /> {label}
    </button>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A bounded integer setting, saved on blur or Enter, shown with its default. */
function NumberRow({
  label,
  hint,
  value,
  fallback,
  min,
  max,
  onSave,
  testid,
}: {
  label: string;
  hint: string;
  value: string | undefined;
  fallback: number;
  min: number;
  max: number;
  onSave: (n: number) => void;
  testid: string;
}) {
  const [draft, setDraft] = useState(value ?? String(fallback));
  useEffect(() => setDraft(value ?? String(fallback)), [value, fallback]);
  const commit = () => {
    const n = Math.floor(Number(draft));
    const clamped = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    setDraft(String(clamped));
    if (String(clamped) !== (value ?? "")) onSave(clamped);
  };
  return (
    <Row label={label} hint={`${hint} · padrão ${fallback}`}>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        inputMode="numeric"
        className="h-8 w-20 text-center"
        data-testid={testid}
      />
    </Row>
  );
}

function Segmented({
  options,
  value,
  onChange,
  testid,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  testid?: string;
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-raised p-0.5" data-testid={testid}>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          data-testid={testid ? `${testid}-${o.toLowerCase()}` : undefined}
          className={cn(
            "rounded px-2.5 py-1 text-xs transition-colors",
            value === o ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

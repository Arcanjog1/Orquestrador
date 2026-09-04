import { useEffect, useState } from "react";
import { ArrowLeft, Check, Loader2, MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ProviderIcon, SectionLabel } from "@/components/orch/primitives";
import { humanReviewReasons } from "@/lib/orchestrator-data";
import { cn } from "@/lib/utils";
import { api, messageOf } from "@/lib/api";
import { Link, useRouter, useSearch } from "@/router";
import type {
  AccountView,
  AppInfo,
  DiagnosticView,
  ProviderName,
  WorkspaceView,
} from "@shared/ipc-contract";

const tabs = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "agents", label: "Agents" },
  { id: "accounts", label: "Accounts & Integrations" },
  { id: "execution", label: "Execution" },
  { id: "git", label: "Git" },
  { id: "advanced", label: "Advanced" },
  { id: "developer", label: "Developer Mode" },
] as const;

type TabId = (typeof tabs)[number]["id"];

/** Setting keys, so the renderer and the settings table agree on one spelling. */
const KEY = {
  autoRun: "execution.autoRun",
  maxIterations: "execution.maxIterations",
  autoRetry: "execution.autoRetry",
  humanReview: "execution.humanReview.",
  theme: "appearance.theme",
  density: "appearance.density",
  language: "general.language",
  startWithSystem: "general.startWithSystem",
  confirmPush: "git.confirmBeforePush",
  autoHandoff: "general.autoHandoff",
  devMode: "developer.mode",
} as const;

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
  workspace,
  diagnostics,
  appInfo,
  reload,
}: {
  accounts: readonly AccountView[];
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
                <SectionLabel>Development</SectionLabel>
                <div className="mt-3 rounded-lg border border-border bg-surface p-4">
                  <div className="flex items-center gap-2">
                    <ProviderIcon provider="github" />
                    <span className="text-sm font-semibold">GitHub</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      Sem login próprio
                    </span>
                  </div>
                  <div className="mt-3 text-sm text-muted-foreground">
                    {workspace?.repositoryUrl
                      ? `Remoto do projeto: ${workspace.repositoryUrl}`
                      : "Nenhum remoto configurado no projeto atual."}
                  </div>
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

          {active === "execution" && (
            <div className="mt-8 space-y-6">
              <Row label="Execução automática" hint="Roda o loop sem pedir confirmação a cada etapa">
                <Switch
                  checked={flag(KEY.autoRun, true)}
                  onCheckedChange={(v) => save(KEY.autoRun, String(v))}
                />
              </Row>
              <Row label="Máximo de iterações" hint="Ao atingir o limite, pede revisão humana">
                <Input
                  value={settings[KEY.maxIterations] ?? "6"}
                  onChange={(e) =>
                    setSettings((p) => ({ ...p, [KEY.maxIterations]: e.target.value }))
                  }
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    save(KEY.maxIterations, String(Number.isFinite(n) && n > 0 ? Math.floor(n) : 6));
                  }}
                  className="h-8 w-20 text-center"
                />
              </Row>
              <Row label="Auto retry" hint="Gera nova instrução automaticamente após falha">
                <Switch
                  checked={flag(KEY.autoRetry, true)}
                  onCheckedChange={(v) => save(KEY.autoRetry, String(v))}
                />
              </Row>
              <div className="border-t border-border pt-6">
                <SectionLabel>Human Review quando</SectionLabel>
                <div className="mt-3 space-y-2.5">
                  {humanReviewReasons.map((r) => (
                    <label key={r.id} className="flex items-start gap-3 text-sm">
                      <Checkbox
                        className="mt-0.5"
                        checked={flag(KEY.humanReview + r.id, true)}
                        onCheckedChange={(v) => save(KEY.humanReview + r.id, String(v === true))}
                      />
                      <span>
                        {r.label}
                        <span className="block text-xs text-muted-foreground">
                          {r.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {active === "appearance" && (
            <div className="mt-8 space-y-6">
              <Row label="Tema" hint="Dark é o padrão do aplicativo">
                <Segmented
                  options={["Dark", "Light", "System"]}
                  value={settings[KEY.theme] ?? "Dark"}
                  onChange={(v) => save(KEY.theme, v)}
                />
              </Row>
              <Row label="Densidade" hint="Compacto reduz o espaçamento da timeline">
                <Segmented
                  options={["Compact", "Comfortable"]}
                  value={settings[KEY.density] ?? "Comfortable"}
                  onChange={(v) => save(KEY.density, v)}
                />
              </Row>
            </div>
          )}

          {active === "developer" && (
            <div className="mt-8 space-y-6">
              <Row label="Developer Mode" hint="Expõe versões, runtimes e o estado do banco">
                <Switch checked={devMode} onCheckedChange={(v) => save(KEY.devMode, String(v))} />
              </Row>
              {devMode && (
                <pre className="overflow-x-auto rounded-lg border border-border bg-background p-3 font-mono text-xs text-muted-foreground">
                  {[
                    `[app] version=${appInfo?.appVersion ?? "—"} packaged=${appInfo?.packaged ?? "—"}`,
                    `[electron] ${appInfo?.electronVersion ?? "—"} · node ${appInfo?.nodeVersion ?? "—"} · chromium ${appInfo?.chromeVersion ?? "—"}`,
                    `[platform] ${appInfo?.platform ?? "—"} ${appInfo?.arch ?? ""}`,
                    `[sqlite] ${appInfo?.sqliteAvailable ? "ok" : "indisponível"}`,
                    ...(diagnostics?.runtimes ?? []).map(
                      (r) => `[runtime:${r.runtimeId}] origin=${r.origin} version=${r.version ?? "—"} ready=${r.ready}`,
                    ),
                    `[workspace] ${workspace?.localPath ?? "nenhum"}`,
                  ].join("\n")}
                </pre>
              )}
            </div>
          )}

          {(active === "general" || active === "agents" || active === "git" || active === "advanced") && (
            <div className="mt-8 space-y-6">
              <Row label="Idioma da interface" hint="Português (Brasil)">
                <Segmented
                  options={["PT-BR", "EN"]}
                  value={settings[KEY.language] ?? "PT-BR"}
                  onChange={(v) => save(KEY.language, v)}
                />
              </Row>
              <Row label="Iniciar com o sistema" hint="Abre o Orquestrador ao ligar o computador">
                <Switch
                  checked={flag(KEY.startWithSystem, false)}
                  onCheckedChange={(v) => save(KEY.startWithSystem, String(v))}
                />
              </Row>
              <Row label="Confirmar antes de push" hint="Sempre pedir revisão em pushes remotos">
                <Switch
                  checked={flag(KEY.confirmPush, true)}
                  onCheckedChange={(v) => save(KEY.confirmPush, String(v))}
                />
              </Row>
              <Row label="Gerar handoff automático" hint="Resumo de continuidade ao atingir 85% de contexto">
                <Switch
                  checked={flag(KEY.autoHandoff, true)}
                  onCheckedChange={(v) => save(KEY.autoHandoff, String(v))}
                />
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

function AccountCard({
  account,
  onReconnect,
  onRemove,
}: {
  account: AccountView;
  onReconnect: () => void;
  onRemove: () => void;
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
    </div>
  );
}

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

function Segmented({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-raised p-0.5">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
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

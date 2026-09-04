import { useEffect, useState } from "react";
import { ArrowLeft, Check, MoreHorizontal, Plus } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { invoke } from "@/lib/bridge";
import { Link, useRouter, useSearch } from "@/router";
import type { AccountView, AppStateView } from "@shared/ipc-contract";

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
 * control and the account card are the design's. Every control that has a home
 * in the settings table reads and writes it; the ones whose feature does not
 * exist yet are disabled and say why, rather than pretending to save.
 */
export function SettingsPage({
  state,
  reloadState,
}: {
  state: AppStateView | null;
  reloadState: () => void;
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
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const settings = state?.settings ?? {};
  const [draft, setDraft] = useState<Record<string, string>>(settings);
  useEffect(() => setDraft(state?.settings ?? {}), [state?.settings]);

  const save = (key: string, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    void invoke("settings:set", { key, value })
      .then(reloadState)
      .catch((e: unknown) =>
        toast(e instanceof Error ? e.message : "Não foi possível salvar."),
      );
  };
  const flag = (key: string, fallback: boolean) =>
    draft[key] === undefined ? fallback : draft[key] === "true";

  const fail = (e: unknown) =>
    toast(e instanceof Error ? e.message : "Não foi possível concluir a ação.");

  const accounts = state?.accounts ?? [];
  const openai = accounts.filter((a) => a.providerId === "openai");
  const anthropic = accounts.filter((a) => a.providerId === "anthropic");
  const devMode = flag(KEY.devMode, false);

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
                      onReconnect={() => toast("O login OpenAI ainda não está disponível.")}
                      onSetDefault={() =>
                        void invoke("accounts:setDefault", { accountId: a.id })
                          .then(reloadState)
                          .catch(fail)
                      }
                      onDisconnect={() =>
                        void invoke("accounts:disconnect", { accountId: a.id })
                          .then(reloadState)
                          .catch(fail)
                      }
                      onRemove={() => setRemoving(a)}
                    />
                  ))}
                  <AddAccount
                    label="Adicionar conta OpenAI"
                    disabled
                    hint="Ainda não gerenciado"
                    onClick={() => {}}
                  />
                </div>
                <div className="mt-4 space-y-2">
                  {anthropic.map((a) => (
                    <AccountCard
                      key={a.id}
                      account={a}
                      onReconnect={() => {
                        setLogin({ provider: "Anthropic", accountId: a.id });
                        void invoke("accounts:connect", { accountId: a.id })
                          .then(reloadState)
                          .catch(fail);
                      }}
                      onSetDefault={() =>
                        void invoke("accounts:setDefault", { accountId: a.id })
                          .then(reloadState)
                          .catch(fail)
                      }
                      onDisconnect={() =>
                        void invoke("accounts:disconnect", { accountId: a.id })
                          .then(reloadState)
                          .catch(fail)
                      }
                      onRemove={() => setRemoving(a)}
                    />
                  ))}
                  <AddAccount
                    label="Adicionar conta Anthropic"
                    onClick={() => {
                      setNewName("");
                      setAdding(true);
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
                      Ainda não gerenciado
                    </span>
                  </div>
                  <div className="mt-3 flex items-center gap-4 text-sm text-muted-foreground">
                    <span>
                      {state?.git?.remoteUrl
                        ? `Remoto do projeto: ${state.git.remoteUrl}`
                        : "Nenhum remoto configurado no projeto atual."}
                    </span>
                  </div>
                </div>
              </section>

              <p className="text-xs text-muted-foreground">
                <strong className="text-foreground/85">Desconectar</strong> preserva o
                perfil da conta no Orquestrador.{" "}
                <strong className="text-foreground/85">Remover</strong> exclui o cadastro e
                exige confirmação.
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
                  value={draft[KEY.maxIterations] ?? "20"}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, [KEY.maxIterations]: e.target.value }))
                  }
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    save(KEY.maxIterations, String(Number.isFinite(n) && n > 0 ? Math.floor(n) : 20));
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
                  value={draft[KEY.theme] ?? "Dark"}
                  onChange={(v) => save(KEY.theme, v)}
                />
              </Row>
              <Row label="Densidade" hint="Compacto reduz o espaçamento da timeline">
                <Segmented
                  options={["Compact", "Comfortable"]}
                  value={draft[KEY.density] ?? "Comfortable"}
                  onChange={(v) => save(KEY.density, v)}
                />
              </Row>
            </div>
          )}

          {active === "developer" && (
            <div className="mt-8 space-y-6">
              <Row label="Developer Mode" hint="Expõe stdout, stderr, exit code, IPC e payloads">
                <Switch
                  checked={devMode}
                  onCheckedChange={(v) => save(KEY.devMode, String(v))}
                />
              </Row>
              {devMode && (
                <pre className="overflow-x-auto rounded-lg border border-border bg-background p-3 font-mono text-xs text-muted-foreground">
                  {[
                    `[app] version=${state?.appVersion ?? "—"}`,
                    `[db] schema ${state?.databaseProblem ? "indisponível" : "ok"}`,
                    ...(state?.diagnostics.runtimes ?? []).map(
                      (r) =>
                        `[runtime:${r.runtimeId}] origin=${r.origin} version=${r.version ?? "—"} healthy=${r.healthy}`,
                    ),
                    `[workspace] ${state?.workspace?.localPath ?? "nenhum"}`,
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
                  value={draft[KEY.language] ?? "PT-BR"}
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
          if (login) void invoke("accounts:connect", { accountId: login.accountId }).catch(fail);
        }}
        onCancel={() => {
          if (login) void invoke("accounts:cancelConnect", { accountId: login.accountId });
        }}
      />

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Adicionar conta Anthropic</DialogTitle>
            <DialogDescription>
              Escolha um nome para identificar esta conta. O aplicativo cuida do resto.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Ex.: Claude Trabalho"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Voltar
            </Button>
            <Button
              disabled={!newName.trim()}
              onClick={() => {
                void invoke("accounts:create", {
                  providerId: "anthropic",
                  displayName: newName.trim(),
                })
                  .then((account) => {
                    setAdding(false);
                    reloadState();
                    setLogin({ provider: "Anthropic", accountId: account.id });
                    return invoke("accounts:connect", { accountId: account.id });
                  })
                  .then(reloadState)
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
            <DialogTitle className="text-sm">Remover {removing?.displayName}?</DialogTitle>
            <DialogDescription>
              O cadastro será excluído do Orquestrador. Para manter o perfil, use
              Desconectar.
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
                void invoke("accounts:remove", { accountId: target.id })
                  .then(() => {
                    reloadState();
                    toast(`${target.displayName} removida`);
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

const humanReviewReasons = [
  { id: "ambiguous", label: "Requisito ambíguo", description: "Existem duas interpretações válidas do objetivo." },
  { id: "destructive", label: "Ação destrutiva", description: "É necessário um force push na branch remota." },
  { id: "security", label: "Segurança", description: "A mudança afeta autenticação." },
  { id: "no-progress", label: "Sem progresso", description: "3 tentativas repetiram o mesmo erro." },
  { id: "iteration-limit", label: "Limite de iterações", description: "O limite configurado de iterações foi atingido." },
  { id: "auth", label: "Autenticação", description: "O usuário precisa concluir o login do provider." },
];

function AccountCard({
  account,
  onReconnect,
  onSetDefault,
  onDisconnect,
  onRemove,
}: {
  account: AccountView;
  onReconnect: () => void;
  onSetDefault: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
}) {
  const connected = account.state === "connected";
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={account.providerId === "google" ? "gemini" : account.providerId} />
        <span className="text-sm font-semibold">{account.displayName}</span>
        {account.isDefault && (
          <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
            padrão
          </span>
        )}
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1 text-xs",
            connected ? "text-success" : account.state === "ambient-credential" ? "text-attention" : "text-muted-foreground",
          )}
        >
          {connected ? <Check className="size-3" /> : <span className="size-2 rounded-full border border-current" />}
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
            <DropdownMenuItem onClick={onSetDefault}>Definir padrão</DropdownMenuItem>
            <DropdownMenuItem onClick={onReconnect}>Reconectar</DropdownMenuItem>
            <DropdownMenuItem onClick={onDisconnect}>Desconectar</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onRemove} className="text-danger focus:text-danger">
              Remover
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {account.problem && (
        <p className="mt-2 text-xs text-attention">{account.problem}</p>
      )}
      <div className="mt-3 flex gap-8">
        <div>
          <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
            Modelo padrão
          </div>
          <div className="mt-1 font-mono text-xs">{account.model ?? "—"}</div>
        </div>
        <div>
          <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
            Raciocínio padrão
          </div>
          <div className="mt-1 text-xs text-primary">{account.reasoning ?? "—"}</div>
        </div>
      </div>
    </div>
  );
}

function AddAccount({
  label,
  onClick,
  disabled = false,
  hint,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "hover:border-primary/40 hover:text-primary",
      )}
    >
      <Plus className="size-3.5" /> {label}
      {hint && <span className="ml-auto text-[11px]">{hint}</span>}
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

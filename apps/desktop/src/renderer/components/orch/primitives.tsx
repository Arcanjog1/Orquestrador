import { HeroPortrait } from './HeroPortrait';
import {
  Check,
  CircleDashed,
  Loader2,
  Pause,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  runStateMeta,
  type Agent,
  type Provider,
  type RunState,
  type StatusTone,
} from "@/lib/orchestrator-data";

export const toneText: Record<StatusTone, string> = {
  neutral: "text-muted-foreground",
  running: "text-running",
  success: "text-success",
  attention: "text-attention",
  danger: "text-danger",
  muted: "text-muted-foreground",
};

export const toneBg: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground/12 text-muted-foreground",
  running: "bg-running/12 text-running",
  success: "bg-success/12 text-success",
  attention: "bg-attention/12 text-attention",
  danger: "bg-danger/12 text-danger",
  muted: "bg-muted-foreground/10 text-muted-foreground",
};

export const toneDot: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  running: "bg-running",
  success: "bg-success",
  attention: "bg-attention",
  danger: "bg-danger",
  muted: "bg-muted-foreground",
};

export function ProviderIcon({
  provider,
  className,
}: {
  provider: Provider;
  className?: string;
}) {
  const base = cn("size-4 shrink-0", className);
  if (provider === "openai") {
    return (
      <svg viewBox="0 0 24 24" className={cn(base, "text-openai")} aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 2.2 20 6.7v10.6L12 21.8 4 17.3V6.7L12 2.2Zm0 2.3-6 3.4v7.2l6 3.4 6-3.4V7.9l-6-3.4Zm0 2.2 4.1 2.3v4.7L12 15.9 7.9 13.6V8.9L12 6.7Zm0 2.3-2.1 1.2v2.4l2.1 1.2 2.1-1.2v-2.4L12 9Z"
        />
      </svg>
    );
  }
  if (provider === "anthropic") {
    return (
      <svg viewBox="0 0 24 24" className={cn(base, "text-anthropic")} aria-hidden="true">
        <path fill="currentColor" d="M7.6 4h3.1l5.7 16h-3.2l-1.2-3.5H6.6L5.4 20H2.2L7.6 4Zm.9 4.3-1.1 5.6h4.4L10.7 8.3H8.5Z" />
        <path fill="currentColor" opacity=".55" d="M16.4 4h3.2l2.2 6.4h-3.2L16.4 4Z" />
      </svg>
    );
  }
  if (provider === "gemini") {
    return (
      <svg viewBox="0 0 24 24" className={cn(base, "text-gemini")} aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 2c.7 4.4 3.6 7.3 8 8-4.4.7-7.3 3.6-8 8-.7-4.4-3.6-7.3-8-8 4.4-.7 7.3-3.6 8-8Z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={cn(base, "text-foreground/80")} aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.2.7-1.4-2.2-.3-4.5-1.1-4.5-5a4 4 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.6 0 0 .9-.3 3 1a7.4 7.4 0 0 1 3.9 0c2.1-1.3 3-1 3-1 .5 1.3.2 2.3.1 2.6a4 4 0 0 1 1 2.7c0 3.9-2.3 4.7-4.5 5 .4.3.7 1 .7 2v2.9c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"
      />
    </svg>
  );
}

export function ModelBadge({ model }: { model: string }) {
  return (
    <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-4 text-muted-foreground">
      {model}
    </span>
  );
}

export function ReasoningBadge({ level }: { level: string }) {
  return (
    <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] leading-4 font-medium text-primary">
      {level}
    </span>
  );
}

export function RoleLabel({ role }: { role: string }) {
  return (
    <span className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
      {role}
    </span>
  );
}

export function AgentIdentity({
  agent,
  compact = false,
}: {
  agent: Agent;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <HeroPortrait role={agent.role} /><ProviderIcon provider={agent.provider} />
      <span className="text-sm font-semibold text-foreground">{agent.agent}</span>
      <RoleLabel role={agent.role} />
      {!compact && (
        <span className="flex items-center gap-1.5">
          {agent.model && <ModelBadge model={agent.model} />}
          {agent.reasoning && <ReasoningBadge level={agent.reasoning} />}
        </span>
      )}
    </div>
  );
}

export function StatusPill({
  state,
  iteration,
}: {
  state: RunState;
  iteration?: number | undefined;
}) {
  const meta = runStateMeta[state];
  const Icon =
    meta.tone === "success"
      ? Check
      : meta.tone === "attention"
        ? state === "PAUSED" || state === "PAUSING"
          ? Pause
          : TriangleAlert
        : meta.tone === "danger"
          ? X
          : state === "CANCELLED"
            ? Square
            : state === "IDLE"
              ? CircleDashed
              : Loader2;

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
          toneBg[meta.tone],
        )}
      >
        <Icon className={cn("size-3.5", meta.tone === "running" && "animate-spin")} />
        {meta.label}
      </span>
      {iteration ? (
        <span className="text-xs text-muted-foreground">Iteração {iteration}</span>
      ) : null}
    </div>
  );
}

export function CheckRow({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {passed ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <X className="size-3.5 text-danger" />
      )}
      <span className={passed ? "text-foreground/85" : "text-danger"}>{label}</span>
    </div>
  );
}

export function StatBlock({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1 text-sm text-foreground">{value}</div>
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
      {children}
    </div>
  );
}

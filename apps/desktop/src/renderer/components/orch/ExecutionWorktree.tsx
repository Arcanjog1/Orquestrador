import { briefText } from '@shared/hero-identity';
import { HeroPortrait } from './HeroPortrait';
import { heroState, questStatus } from '@shared/hero-identity';
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Crosshair,
  GitBranch,
  Maximize2,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { executionGraph, type ExecutionNode } from "@shared/execution-graph";
import type { ChatMessageView, RunDetailView } from "@shared/ipc-contract";
import { isRunOver } from "@shared/activity";

const WIDTH = 232,
  HEIGHT = 116,
  GAP = 280,
  ROW = 156;
export function ExecutionWorktree({
  detail,
  messages,
  onEvidence,
  onDiff,
  onReview,
  onCancel,
  onCancelTask,
}: {
  detail: RunDetailView;
  messages: readonly ChatMessageView[];
  onEvidence: () => void;
  onDiff?: () => void;
  onReview?: () => void;
  onCancel?: () => void;
  onCancelTask?: (taskId: string) => void;
}) {
  const graph = useMemo(
    () => executionGraph(detail, messages),
    [detail, messages],
  );
  const [selected, select] = useState<string | null>(null);
  const [collapsed, collapse] = useState<Set<number>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 40, y: 90 });
  const [viewport, setViewport] = useState({ width: 900, height: 700 });
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  const terminal = isRunOver(detail.run.status);
  useEffect(() => {
    const observer = new ResizeObserver(
      ([entry]) =>
        entry &&
        setViewport({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        }),
    );
    if (surface.current) observer.observe(surface.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    select(null);
    collapse(new Set());
    setZoom(1);
    setOffset({ x: 40, y: 90 });
  }, [detail.run.id]);
  const layout = useMemo(() => {
    const hiddenRows = new Set(
      graph.nodes
        .filter(
          (n) =>
            collapsed.has(n.iteration) &&
            n.kind !== "orchestrator" &&
            n.kind !== "done" &&
            n.kind !== "human" &&
            n.kind !== "user",
        )
        .map((n) => n.row),
    );
    const rows = [...new Set(graph.nodes.map((n) => n.row))]
      .filter((r) => !hiddenRows.has(r))
      .sort((a, b) => a - b);
    const rowMap = new Map(rows.map((r, i) => [r, i]));
    const laneCount = Math.max(1, ...graph.nodes.map(n => n.lane));
    return graph.nodes
      .filter((n) => !hiddenRows.has(n.row))
      .map((n) => ({ ...n, row: rowMap.get(n.row) ?? n.row,
        x: (rowMap.get(n.row) ?? n.row) * GAP,
        y: (n.lane === 0 ? (laneCount - 1) / 2 : n.lane - 1) * ROW,
      }));
  }, [graph, collapsed]);
  const byId = useMemo(() => new Map(layout.map((n) => [n.id, n])), [layout]);
  const displayedEdges = useMemo(() => {
    const edges: typeof graph.edges = [];
    const outgoing = new Map<string, typeof graph.edges>();
    graph.edges.forEach((e) =>
      outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]),
    );
    for (const node of layout) {
      const queue = [...(outgoing.get(node.id) ?? [])],
        seen = new Set<string>();
      while (queue.length) {
        const edge = queue.shift()!;
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        if (byId.has(edge.to))
          edges.push({ ...edge, id: node.id + ">" + edge.to, from: node.id });
        else queue.push(...(outgoing.get(edge.to) ?? []));
      }
    }
    return edges;
  }, [graph, layout, byId]);
  const selectedNode = graph.nodes.find((n) => n.id === selected);
  const active = graph.nodes.find(
    (n) => ["running", "started"].includes(n.status) && !terminal,
  );
  const participants = new Map(
    detail.invocations.map((i) => [i.agentId ?? i.workerId ?? i.role, i]),
  );
  function focus(node: ExecutionNode) {
    const position = byId.get(node.id);
    if (!position) return;
    setOffset({
      x: viewport.width / 2 - (position.x + WIDTH / 2) * zoom,
      y: viewport.height / 2 - (position.y + HEIGHT / 2) * zoom,
    });
    select(node.id);
  }
  function fit() {
    const width = Math.max(...layout.map((n) => n.x + WIDTH), WIDTH);
    const height = Math.max(...layout.map((n) => n.y + HEIGHT), HEIGHT);
    const next = Math.min(
      1.2,
      Math.max(
        0.15,
        Math.min(
          (viewport.width - 60) / width,
          (viewport.height - 130) / height,
        ),
      ),
    );
    setZoom(next);
    setOffset({ x: (viewport.width - width * next) / 2, y: 80 + (viewport.height - 130 - height * next) / 2 });
  }
  function scale(factor: number) {
    const next = Math.min(2, Math.max(0.15, zoom * factor));
    setOffset((p) => ({
      x: viewport.width / 2 - ((viewport.width / 2 - p.x) * next) / zoom,
      y: viewport.height / 2 - ((viewport.height / 2 - p.y) * next) / zoom,
    }));
    setZoom(next);
  }
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey) scale(event.deltaY < 0 ? 1.1 : 1 / 1.1);
      else setOffset((p) => ({ x: p.x - event.deltaX, y: p.y - event.deltaY }));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoom, viewport]);
  const visible = layout.filter((n) => {
    const x = n.x * zoom + offset.x,
      y = n.y * zoom + offset.y;
    return (
      x > -WIDTH * zoom - 200 &&
      x < viewport.width + 200 &&
      y > -HEIGHT * zoom - 200 &&
      y < viewport.height + 200
    );
  });
  const related = (direction: "parent" | "child") =>
    graph.edges
      .filter((e) =>
        direction === "parent" ? e.to === selected : e.from === selected,
      )
      .map(
        (e) =>
          graph.nodes.find(
            (n) => n.id === (direction === "parent" ? e.from : e.to),
          )!,
      )
      .filter(Boolean);
  return (
    <div className="execution-worktree" data-testid="execution-worktree" data-orientation="horizontal">
      <div className="worktree-summary">
        <span>
          <GitBranch size={14} /> Mapa da missão · {questStatus(detail.run.status)}
        </span>
        <span>
          {participants.size} agentes · {detail.invocations.length} invocações
        </span>
        <span>
          {detail.verifications.filter((v) => v.passed).length}/
          {detail.verifications.length} verificações
        </span>
        <span>{detail.baseline.branch ?? "Sem branch local"}</span>
      </div>
      <div className="worktree-body">
        <div
          ref={surface}
          className="worktree-canvas"
          tabIndex={0}
          aria-label="Mapa da execução, da esquerda para a direita. Arraste para navegar; use mais e menos para zoom."
          data-testid="worktree-canvas"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              ox: offset.x,
              oy: offset.y,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d)
              setOffset({
                x: d.ox + e.clientX - d.x,
                y: d.oy + e.clientY - d.y,
              });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(e) => {
            if (e.key === "+" || e.key === "=") scale(1.2);
            if (e.key === "-") scale(1 / 1.2);
            if (e.key === "0") fit();
            if (e.key === "Escape") select(null);
            if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {
              e.preventDefault();
              const target = related(
                ["ArrowUp", "ArrowLeft"].includes(e.key) ? "parent" : "child",
              )[0];
              if (target) {
                const n = byId.get(target.id);
                if (n) focus(n);
              }
            }
          }}
        >
          <div
            className="worktree-toolbar"
            role="toolbar"
            aria-label="Navegação do grafo"
          >
            <button
              onClick={() => scale(1 / 1.2)}
              title="Diminuir zoom"
              aria-label="Diminuir zoom"
            >
              <Minus size={15} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => scale(1.2)}
              title="Aumentar zoom"
              aria-label="Aumentar zoom"
            >
              <Plus size={15} />
            </button>
            <button
              onClick={fit}
              title="Ajustar à tela"
              aria-label="Ajustar à tela"
            >
              <Maximize2 size={15} />
            </button>
            <button
              onClick={() => {
                const n = byId.get(active?.id ?? layout.at(-1)?.id ?? "");
                if (n) focus(n);
              }}
              title="Centralizar execução atual"
              aria-label="Centralizar execução atual"
            >
              <Crosshair size={15} />
            </button>
            <button
              onClick={() =>
                collapse(
                  collapsed.size
                    ? new Set()
                    : new Set(
                        graph.nodes
                          .filter(
                            (n) =>
                              n.iteration > 0 &&
                              n.finishedAt &&
                              n.iteration !== active?.iteration,
                          )
                          .map((n) => n.iteration),
                      ),
                )
              }
            >
              {collapsed.size ? "Expandir" : "Minimizar concluídas"}
            </button>
          </div>
          <div
            className="worktree-world"
            style={{
              transform: `translate(${offset.x}px,${offset.y}px) scale(${zoom})`,
            }}
          >
            <svg
              className="worktree-edges"
              width={Math.max(
                viewport.width / zoom,
                ...layout.map((n) => n.x + WIDTH),
              )}
              height={Math.max(
                viewport.height / zoom,
                ...layout.map((n) => n.y + HEIGHT),
              )}
              aria-hidden="true"
            >
              {displayedEdges.map((edge) => {
                const from = byId.get(edge.from),
                  to = byId.get(edge.to);
                if (!from || !to) return null;
                const x1 = from.x + WIDTH,
                  y1 = from.y + HEIGHT / 2,
                  x2 = to.x,
                  y2 = to.y + HEIGHT / 2;
                return (
                  <path
                    key={edge.id}
                    d={`M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}`}
                    className={`edge-${edge.kind}`}
                  />
                );
              })}
            </svg>
            {visible.map((node) => (
              <article
                key={node.id}
                className={`execution-node node-${node.kind} ${selected === node.id ? "node-selected" : ""}`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: WIDTH,
                  height: HEIGHT,
                }}
                data-node-id={node.id}
                data-status={node.status}
              >
                <button
                  className="node-content"
                  onClick={() => select(node.id)}
                  aria-label={`${node.label}: ${node.status}. Ver resposta completa`}
                >
                  <span className="node-heading">
                    {(node.invocation || node.kind === "orchestrator") && <HeroPortrait size={32} role={node.invocation?.role ?? "ORCHESTRATOR"} state={heroState(node.status)} />}
                    <span
                      className={
                        !terminal &&
                        ["running", "started"].includes(node.status)
                          ? "node-pulse"
                          : "node-dot"
                      }
                    />
                    <strong>{node.label}</strong>
                    <span className="node-state">{questStatus(node.status)}</span>
                  </span>
                  <span className="node-summary">
                    {briefText(node.summary, 100) || (node.finishedAt ? "Sem resposta registrada." : "Aguardando resultado.")}
                  </span>
                  <span className="node-footer">
                    {node.invocation?.model ?? node.kind}{" "}
                    <span>Ver detalhes →</span>
                  </span>
                </button>
                {node.kind === "orchestrator" && (
                  <button
                    className="node-collapse"
                    aria-label={
                      collapsed.has(node.iteration)
                        ? "Expandir branch"
                        : "Recolher branch"
                    }
                    onClick={() =>
                      collapse((prev) => {
                        const next = new Set(prev);
                        if (next.has(node.iteration))
                          next.delete(node.iteration);
                        else next.add(node.iteration);
                        return next;
                      })
                    }
                  >
                    {collapsed.has(node.iteration) ? (
                      <ChevronRight size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                  </button>
                )}
              </article>
            ))}
          </div>
          <div className="worktree-legend">
            ● Orquestrador <span>● Equipe</span>
            <span>● Evidência</span> · Esquerda → direita · Arraste para navegar
          </div>
        </div>
        {selectedNode && (
          <aside className="worktree-detail" data-testid="node-details">
            <div className="detail-heading">
              <div>
                <small>
                  {selectedNode.kind} · rodada {selectedNode.iteration}
                </small>
                <h2>{selectedNode.label}</h2>
              </div>
              <button aria-label="Fechar detalhes" onClick={() => select(null)}>
                <X size={17} />
              </button>
            </div>
            <p className="detail-status">
              {selectedNode.status === "done" && <Check size={15} />}{" "}
              {selectedNode.status}
            </p>
            {selectedNode.invocation && (
              <dl>
                <dt>Modelo</dt>
                <dd>{selectedNode.invocation.model ?? "Não informado"}</dd>
                <dt>Raciocínio</dt>
                <dd>{selectedNode.invocation.reasoning ?? "Não informado"}</dd>
                <dt>Duração</dt>
                <dd>
                  {selectedNode.invocation.durationMs === null
                    ? "Não informada"
                    : `${(selectedNode.invocation.durationMs / 1000).toFixed(1)} s`}
                </dd>
                <dt>Tokens / custo</dt>
                <dd>
                  {selectedNode.invocation.totalTokens ?? "Não informado"} /{" "}
                  {selectedNode.invocation.costUsd === null
                    ? "Não informado"
                    : `US$ ${selectedNode.invocation.costUsd}`}
                </dd>
              </dl>
            )}
            <details open>
              <summary>Ver resposta completa</summary>
              <pre>{selectedNode.fullText || "Sem texto registrado."}</pre>
            </details>
            {selectedNode.invocation?.task && (
              <details>
                <summary>Tarefa enviada</summary>
                <pre>{selectedNode.invocation.task}</pre>
              </details>
            )}
            <details>
              <summary>Registros e evidências</summary>
              <pre>
                {JSON.stringify(
                  {
                    sources: selectedNode.sourceIds,
                    invocation: selectedNode.invocation,
                    metadata: selectedNode.metadata,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <div className="detail-actions">
              {selectedNode.taskId && !selectedNode.finishedAt && !terminal && (
                <button onClick={() => onCancelTask?.(selectedNode.taskId!)}>
                  Cancelar branch
                </button>
              )}
              <button onClick={onEvidence}>Ver evidências / arquivos</button>
              {onDiff && <button onClick={onDiff}>Ver diff</button>}
              {selectedNode.kind === "human" && onReview && (
                <>
                  <button onClick={onReview}>Revisar / continuar</button>
                  <button onClick={onCancel}>Cancelar execução</button>
                </>
              )}
            </div>
            <div className="detail-actions">
              {related("parent").map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    const found = byId.get(n.id);
                    if (found) focus(found);
                    else select(n.id);
                  }}
                >
                  ↑ {n.label}
                </button>
              ))}
              {related("child").map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    const found = byId.get(n.id);
                    if (found) focus(found);
                    else select(n.id);
                  }}
                >
                  ↓ {n.label}
                </button>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

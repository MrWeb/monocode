import "@xyflow/react/dist/style.css";
import "./BlueprintView.css";
import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  addEdge,
  BaseEdge,
  getBezierPath,
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Handle,
  MarkerType,
  Position,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useConnection,
  useInternalNode,
  useNodeConnections,
  useStore,
  useStoreApi,
  useReactFlow,
  useNodesState,
  type Connection,
  type ConnectionLineComponentProps,
  type EdgeProps,
  type InternalNode,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  createPath,
  readTextFile,
  writeTextFile,
} from "../../../platform/tauri/fs";
import {
  borderPoint,
  center,
  sideOf,
  spreadBoxes,
  type Rect,
} from "../geometry";
import { DashboardSquare, Flowchart } from "../../../shared/ui/icons";
import { autoLayout } from "../layout";
import {
  ARROW_COLOR,
  BLUEPRINT_FILE,
  BLUEPRINT_KINDS,
  BLUEPRINT_LINES,
  BLUEPRINT_SHAPES,
  kindColor,
  parseBlueprint,
  serializeBlueprint,
  type BlueprintKind,
  type BlueprintLine,
  type BlueprintShape,
} from "../blueprint";

type BoxData = {
  kind: BlueprintKind;
  shape: BlueprintShape;
  line: BlueprintLine;
  title: string;
  instructions: string;
  color: string;
};
type BoxNode = Node<BoxData, "box">;

function Box({ data, selected }: NodeProps<BoxNode>) {
  const linked = useNodeConnections({ handleType: "source" }).length > 0;
  const connecting = useConnection((c) => c.inProgress);
  const stadium = data.shape === "stadium";
  const dashed = data.line === "dashed";
  return (
    <div
      className={`min-w-[140px] max-w-[240px] border-[3px] text-[12px] text-content ${
        stadium ? "rounded-full" : "rounded-lg"
      } ${
        // A dashed border sits just outside the fill, so the canvas shows
        // through the gaps instead of the box's own background.
        dashed ? "p-[3px]" : ""
      }`}
      style={{
        borderColor: data.color,
        borderStyle: data.line,
        outline: selected ? `2px solid ${data.color}` : undefined,
        outlineOffset: 2,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="blueprint-target"
        // While an arrow is being dragged the whole box takes the drop; the
        // rest of the time it lets clicks and drags through to the box.
        style={
          connecting
            ? {
                inset: 0,
                width: "100%",
                height: "100%",
                transform: "none",
                borderRadius: 0,
                zIndex: 1,
              }
            : undefined
        }
      />
      <div
        className={`bg-background-base py-2 ${
          stadium
            ? "rounded-full px-6 text-center"
            : `${dashed ? "rounded-[4px]" : "rounded-[6px]"} px-3`
        }`}
      >
        <div className="text-[10px] uppercase tracking-wide text-content/50">
          {data.kind}
        </div>
        <div className="font-medium">{data.title || "Untitled"}</div>
        {data.instructions ? (
          <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-content/60">
            {data.instructions}
          </div>
        ) : null}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={`blueprint-dot ${linked ? "blueprint-dot-linked" : ""}`}
        style={{ background: data.color, right: DOT_INSET }}
      />
    </div>
  );
}

const NODE_TYPES = { box: Box };

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-content/60">{label}</div>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid grid-cols-2 gap-0.5 rounded-md border border-content/10 p-0.5"
      >
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            onClick={() => onChange(o.id)}
            className={`rounded-[5px] px-2 py-1 ${
              value === o.id
                ? "bg-selection text-content"
                : "text-content/50 hover:text-content"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/*
 * React Flow measures dot positions with getBoundingClientRect, which under
 * CrispZoom's CSS zoom comes back in the wrong units, so arrows drift off the
 * dots. Anchor arrows on the box itself instead: offsetWidth/Height are
 * unaffected by zoom.
 */
/** How far a start dot sits inside the box's border. */
const DOT_INSET = 2;

function rightMiddle(n: InternalNode) {
  return {
    x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) - DOT_INSET,
    y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2,
  };
}

function rectOf(n: InternalNode): Rect {
  return {
    ...n.internals.positionAbsolute,
    width: n.measured.width ?? 0,
    height: n.measured.height ?? 0,
  };
}

const SIDE_POSITION = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
} as const;

/**
 * Each arrow attaches where the line between the two boxes crosses their
 * borders, so its start dot slides along the edge as the boxes move.
 */
function BoxEdge({ source, target, label, markerEnd, style, data }: EdgeProps) {
  const from = useInternalNode<BoxNode>(source);
  const to = useInternalNode<BoxNode>(target);
  if (!from || !to) return null;
  const fromRect = rectOf(from);
  const toRect = rectOf(to);
  const a = borderPoint(fromRect, from.data.shape, center(toRect), DOT_INSET);
  const b = borderPoint(toRect, to.data.shape, center(fromRect));
  const [path, labelX, labelY] = getBezierPath({
    sourceX: a.x,
    sourceY: a.y,
    sourcePosition: SIDE_POSITION[sideOf(fromRect, a)],
    targetX: b.x,
    targetY: b.y,
    targetPosition: SIDE_POSITION[sideOf(toRect, b)],
  });
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: String(data?.color ?? ARROW_COLOR),
          strokeDasharray: data?.line === "dashed" ? "6 4" : undefined,
        }}
        label={label}
        labelX={labelX}
        labelY={labelY}
      />
      <circle
        cx={a.x}
        cy={a.y}
        r={6}
        fill={from.data.color}
        stroke="#fff"
        strokeWidth={2}
      />
    </>
  );
}

function BoxConnectionLine({
  fromNode,
  toNode,
  pointer,
  connectionLineStyle,
}: ConnectionLineComponentProps<BoxNode>) {
  const [tx, ty, zoom] = useStore((st) => st.transform);
  const a = rightMiddle(fromNode);
  // `pointer` is in screen pixels relative to the pane; bring it into the
  // canvas. Over a box, the preview snaps to its border in the mouse's
  // direction instead of the hidden left drop point.
  const mouse = { x: (pointer.x - tx) / zoom, y: (pointer.y - ty) / zoom };
  const overBox = toNode && toNode.id !== fromNode.id ? toNode : null;
  const end = overBox
    ? borderPoint(rectOf(overBox), overBox.data.shape, mouse)
    : mouse;
  const [path] = getBezierPath({
    sourceX: a.x,
    sourceY: a.y,
    sourcePosition: Position.Right,
    targetX: end.x,
    targetY: end.y,
    targetPosition: overBox
      ? SIDE_POSITION[sideOf(rectOf(overBox), end)]
      : Position.Left,
  });
  return (
    <path
      d={path}
      fill="none"
      stroke="#e8f1ff"
      strokeWidth={1.5}
      style={connectionLineStyle}
    />
  );
}

const EDGE_TYPES = { box: BoxEdge };

/**
 * WebKit bitmap-scales content under `transform: scale()`, so boxes blur when
 * zoomed (bugs.webkit.org/264954). After React Flow writes its viewport
 * transform, swap the scale for CSS `zoom`, which re-lays out and redraws the
 * boxes at the new size. Translate is divided by zoom because `zoom` also
 * scales it.
 */
function CrispZoom() {
  const store = useStoreApi();
  useEffect(() => {
    const apply = () => {
      const { domNode, transform } = store.getState();
      const viewport = domNode?.querySelector<HTMLElement>(
        ".react-flow__viewport",
      );
      if (!viewport) return;
      const [x, y, zoom] = transform;
      viewport.style.transform = `translate(${x / zoom}px, ${y / zoom}px)`;
      viewport.style.zoom = String(zoom);
    };
    apply();
    // Subscribed after React Flow's own viewport listener, so this runs last.
    return store.subscribe(apply);
  }, [store]);
  return null;
}
const arrowHead = (color: string) =>
  ({ type: MarkerType.ArrowClosed, color }) as const;

function BlueprintCanvas({ cwd }: { cwd: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<BoxNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSaved = useRef("");
  const { fitView } = useReactFlow();

  const boxRects = () =>
    nodes.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      width: n.measured?.width ?? 0,
      height: n.measured?.height ?? 0,
    }));
  // Moves boxes to new positions, saved like a drag, then refits the view.
  const placeBoxes = (placed: { id: string; x: number; y: number }[]) => {
    const at = new Map(placed.map((b) => [b.id, b]));
    setNodes((ns) =>
      ns.map((n) => {
        const b = at.get(n.id);
        return b ? { ...n, position: { x: b.x, y: b.y } } : n;
      }),
    );
    requestAnimationFrame(() => void fitView({ duration: 300 }));
  };
  // Spread: keep the drawing, only push apart boxes that overlap or touch.
  const arrange = () => placeBoxes(spreadBoxes(boxRects()));
  // Auto layout: redo the whole drawing in columns that follow the arrows.
  const relayout = () => placeBoxes(autoLayout(boxRects(), edges));
  const path = `${cwd}/${BLUEPRINT_FILE}`;

  useEffect(() => {
    let live = true;
    setReady(false);
    setError(null);
    readTextFile(path)
      .then((text) => {
        const bp = parseBlueprint(text);
        lastSaved.current = serializeBlueprint(bp);
        setNodes(
          bp.nodes.map(({ id, x, y, ...data }) => ({
            id,
            type: "box",
            position: { x, y },
            data,
          })),
        );
        setEdges(
          bp.edges.map(({ line, color, ...e }) => ({
            ...e,
            type: "box",
            zIndex: 1,
            data: { line, color },
            markerEnd: arrowHead(color),
          })),
        );
        if (live) setReady(true);
      })
      .catch((e) => {
        if (!live) return;
        setNodes([]);
        setEdges([]);
        lastSaved.current = "";
        // A missing file starts an empty blueprint; anything else (corrupt,
        // unreadable) stays untouched and is never overwritten.
        if (/no such file|not found|os error 2/i.test(String(e)))
          setReady(true);
        else setError(`Cannot load ${BLUEPRINT_FILE}: ${String(e)}`);
      });
    return () => {
      live = false;
    };
  }, [path, setNodes, setEdges]);

  useEffect(() => {
    if (!ready) return;
    const text = serializeBlueprint({
      version: 1,
      nodes: nodes.map((n) => ({
        id: n.id,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
        ...n.data,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: typeof e.label === "string" ? e.label : "",
        line: e.data?.line === "dashed" ? "dashed" : "solid",
        color: String(e.data?.color ?? ARROW_COLOR),
      })),
    });
    if (text === lastSaved.current) return;
    const timer = setTimeout(async () => {
      try {
        try {
          await writeTextFile(path, text);
        } catch {
          // First save: .monocode/ does not exist yet.
          await createPath(cwd, BLUEPRINT_FILE, false).catch(() => {});
          await writeTextFile(path, text);
        }
        lastSaved.current = text;
        setError(null);
      } catch (e) {
        setError(`Cannot save blueprint: ${String(e)}`);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [nodes, edges, ready, path, cwd]);

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) =>
        addEdge(
          {
            ...c,
            id: crypto.randomUUID(),
            type: "box",
            zIndex: 1,
            label: "",
            data: { line: "solid", color: ARROW_COLOR },
            markerEnd: arrowHead(ARROW_COLOR),
          },
          es,
        ),
      ),
    [setEdges],
  );

  const addBox = (kind: BlueprintKind) => {
    const n = nodes.length;
    setNodes((ns) => [
      ...ns.map((x) => ({ ...x, selected: false })),
      {
        id: crypto.randomUUID(),
        type: "box",
        position: { x: 40 + (n % 6) * 40, y: 40 + (n % 6) * 40 },
        selected: true,
        data: {
          kind,
          shape: "rectangle",
          line: "solid",
          title: "",
          instructions: "",
          color: kindColor(kind),
        },
      },
    ]);
  };

  const selectedNode = nodes.find((n) => n.selected);
  const selectedEdge = selectedNode ? undefined : edges.find((e) => e.selected);
  const patchNode = (patch: Partial<BoxData>) =>
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selectedNode?.id ? { ...n, data: { ...n.data, ...patch } } : n,
      ),
    );

  const field =
    "w-full rounded-md border border-content/10 bg-transparent px-2 py-1 text-[12px] text-content outline-none focus:border-content/30";

  return (
    <div className="flex h-full w-full bg-background-base text-content">
      <div className="min-w-0 flex-1" data-testid="blueprint-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          connectionLineComponent={BoxConnectionLine}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={(c) => c.source !== c.target}
          connectionRadius={36}
          connectOnClick={false}
          colorMode="dark"
          style={{ background: "#1a4d9c" }}
          defaultEdgeOptions={{
            style: { stroke: "#e8f1ff", strokeWidth: 1.5 },
          }}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          {/* Blueprint paper: fine grid with a stronger line every 5 squares. */}
          <Background
            id="minor"
            bgColor="#1a4d9c"
            variant={BackgroundVariant.Lines}
            gap={16}
            color="rgba(255,255,255,0.14)"
          />
          <Background
            id="major"
            bgColor="transparent"
            variant={BackgroundVariant.Lines}
            gap={80}
            color="rgba(255,255,255,0.3)"
          />
          <Controls showInteractive={false}>
            <ControlButton
              onClick={arrange}
              title="Arrange boxes"
              aria-label="Arrange boxes"
            >
              <DashboardSquare />
            </ControlButton>
            <ControlButton
              onClick={relayout}
              title="Auto layout (follows the arrows)"
              aria-label="Auto layout"
            >
              <Flowchart />
            </ControlButton>
          </Controls>
          <CrispZoom />
        </ReactFlow>
      </div>
      <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-stroke p-3 text-[12px]">
        {/* MiniMap scales by style.width/height: they must be numbers. */}
        <MiniMap
          pannable
          zoomable
          ariaLabel="Blueprint overview"
          style={{
            position: "static",
            margin: 0,
            width: 232,
            height: 140,
            borderRadius: 6,
            background: "#1a4d9c",
            border: "1px solid rgba(128,128,128,0.3)",
          }}
          maskColor="rgba(0,0,0,0.35)"
          nodeColor={(n) => (n.data as BoxData).color}
        />
        <div>
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-content/50">
            Add box
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {BLUEPRINT_KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                disabled={!ready}
                onClick={() => addBox(k.id)}
                className="flex items-center gap-1.5 rounded-md border border-content/10 px-2 py-1 text-left hover:bg-selection disabled:opacity-40"
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: k.color }}
                />
                {k.label}
              </button>
            ))}
          </div>
          <div className="mt-2 text-content/50">
            Drag from a box's right dot to another box to draw an arrow.
          </div>
        </div>

        {selectedNode ? (
          <div className="flex flex-col gap-2">
            <div className="text-[11px] uppercase tracking-wide text-content/50">
              Box
            </div>
            <input
              className={field}
              placeholder="Title"
              value={selectedNode.data.title}
              onChange={(e) => patchNode({ title: e.target.value })}
            />
            <textarea
              className={`${field} min-h-[120px] resize-y`}
              placeholder="Instructions"
              value={selectedNode.data.instructions}
              onChange={(e) => patchNode({ instructions: e.target.value })}
            />
            <select
              className={field}
              value={selectedNode.data.kind}
              onChange={(e) => {
                const kind = e.target.value as BlueprintKind;
                patchNode({ kind, color: kindColor(kind) });
              }}
            >
              {BLUEPRINT_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            <Choice
              label="Shape"
              options={BLUEPRINT_SHAPES}
              value={selectedNode.data.shape}
              onChange={(shape) => patchNode({ shape })}
            />
            <Choice
              label="Line"
              options={BLUEPRINT_LINES}
              value={selectedNode.data.line}
              onChange={(line) => patchNode({ line })}
            />
            <label className="flex items-center gap-2 text-content/60">
              Color
              <input
                type="color"
                value={selectedNode.data.color}
                onChange={(e) => patchNode({ color: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="rounded-md bg-red-600 px-2 py-1 text-white hover:bg-red-500"
              onClick={async () => {
                const name = selectedNode.data.title || "this box";
                const ok = await ask(`Delete ${name} and its arrows?`, {
                  title: "MonoCode",
                  kind: "warning",
                  okLabel: "Delete",
                });
                if (!ok) return;
                setNodes((ns) => ns.filter((n) => n.id !== selectedNode.id));
                setEdges((es) =>
                  es.filter(
                    (e) =>
                      e.source !== selectedNode.id &&
                      e.target !== selectedNode.id,
                  ),
                );
              }}
            >
              Delete box
            </button>
          </div>
        ) : null}

        {selectedEdge ? (
          <div className="flex flex-col gap-2">
            <div className="text-[11px] uppercase tracking-wide text-content/50">
              Arrow
            </div>
            <input
              className={field}
              placeholder="Label (calls, reads from…)"
              value={
                typeof selectedEdge.label === "string" ? selectedEdge.label : ""
              }
              onChange={(e) =>
                setEdges((es) =>
                  es.map((x) =>
                    x.id === selectedEdge.id
                      ? { ...x, label: e.target.value }
                      : x,
                  ),
                )
              }
            />
            <Choice
              label="Line"
              options={BLUEPRINT_LINES}
              value={selectedEdge.data?.line === "dashed" ? "dashed" : "solid"}
              onChange={(line) =>
                setEdges((es) =>
                  es.map((x) =>
                    x.id === selectedEdge.id
                      ? { ...x, data: { ...x.data, line } }
                      : x,
                  ),
                )
              }
            />
            <label className="flex items-center gap-2 text-content/60">
              Color
              <input
                type="color"
                value={String(selectedEdge.data?.color ?? ARROW_COLOR)}
                onChange={(e) => {
                  const color = e.target.value;
                  setEdges((es) =>
                    es.map((x) =>
                      x.id === selectedEdge.id
                        ? {
                            ...x,
                            data: { ...x.data, color },
                            markerEnd: arrowHead(color),
                          }
                        : x,
                    ),
                  );
                }}
              />
            </label>
            <button
              type="button"
              className="rounded-md bg-red-600 px-2 py-1 text-white hover:bg-red-500"
              onClick={async () => {
                const ok = await ask("Delete this arrow?", {
                  title: "MonoCode",
                  kind: "warning",
                  okLabel: "Delete",
                });
                if (!ok) return;
                setEdges((es) => es.filter((x) => x.id !== selectedEdge.id));
              }}
            >
              Delete arrow
            </button>
          </div>
        ) : null}

        {error ? <div className="text-red-400">{error}</div> : null}
      </aside>
    </div>
  );
}

// Nothing else in the app catches render errors, so one here would blank the
// whole window.
class BlueprintBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="h-full w-full overflow-auto bg-background-base p-4 text-[12px] text-red-400">
        <div className="mb-2 font-medium">
          Blueprint crashed: {error.message}
        </div>
        <pre className="whitespace-pre-wrap text-content/60">{error.stack}</pre>
      </div>
    );
  }
}

export function BlueprintView({ cwd }: { cwd: string }) {
  return (
    <BlueprintBoundary>
      <ReactFlowProvider>
        <BlueprintCanvas cwd={cwd} />
      </ReactFlowProvider>
    </BlueprintBoundary>
  );
}

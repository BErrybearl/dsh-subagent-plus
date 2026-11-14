window.__ModuleLoader__.load({
	id: "dsh-cli-hub",
	factory: (require) => {
		var module = { exports: {} };
		(function (module, exports) {
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react2 = __toESM(require("react"), 1);

var import_react = __toESM(require("react"), 1);
var h = import_react.default.createElement;
var DEFAULTS = {
  dock: true,
  tab: true,
  scope: "session",
  autoHideSeconds: 30,
  maxCards: 20,
  allowStop: true,
  includeNative: false,
  hideWhenIdle: false,
  showCost: false
};
var HIDE_KEY = "dsh-cli-hub.panel.hideAt";
var OVERRIDE_KEY = "dsh-cli-hub.panel.override";
var EVT = "dsh-cli-hub:panel-cfg";
function readOverrides() {
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function writeOverrides(next) {
  try {
    window.localStorage.setItem(OVERRIDE_KEY, JSON.stringify(next));
  } catch {
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(EVT));
    } catch {
    }
  }
}
function readHideAt() {
  try {
    return Number(window.localStorage.getItem(HIDE_KEY)) || 0;
  } catch {
    return 0;
  }
}
function rpc(connection, endpoint, payload, timeout = 2e4) {
  return connection.rpc.call("/api", `dsh-cli-hub/${endpoint}`, payload, AbortSignal.timeout(timeout)).then((result) => {
    if (!result?.ok) throw new Error(result?.error?.message ?? "rpc failed");
    return result.value;
  });
}
var POLL_ACTIVE = 2e3;
var POLL_IDLE = 6e3;
var POLL_HIDDEN = 12e3;
var INTERRUPT_GRACE_MS = 1e4;
function createRunsStore() {
  let snapshot = { runs: [], natives: [], stats: null, cfg: null, now: Date.now() };
  const subs = /* @__PURE__ */ new Set();
  let timer = null;
  let epoch = 0;
  let pulling = false;
  let getConnection = () => null;
  const interrupted = /* @__PURE__ */ new Map();
  const emit = () => {
    for (const cb of subs) {
      try {
        cb(snapshot);
      } catch {
      }
    }
  };
  const allRows = () => [...snapshot.runs || [], ...snapshot.natives || []];
  const busy = () => allRows().some((run) => run.status === "running" || run.activity === "running");
  const hidden = () => typeof document !== "undefined" && document.visibilityState !== "visible";
  const delay = () => hidden() ? POLL_HIDDEN : busy() ? POLL_ACTIVE : POLL_IDLE;
  const pull = async () => {
    const connection = getConnection();
    if (!connection || pulling) return;
    pulling = true;
    try {
      const next = await rpc(connection, "runs", { limit: 40 });
      if (next) {
        snapshot = next;
        const now = Date.now();
        for (const run of allRows()) if (run.status !== "running" && run.activity !== "running") interrupted.delete(run.id);
        for (const [id, at] of interrupted) if (now - at > INTERRUPT_GRACE_MS) interrupted.delete(id);
        emit();
      }
    } catch {
    } finally {
      pulling = false;
    }
  };
  const schedule = (ms) => {
    if (timer) clearTimeout(timer);
    epoch += 1;
    const gen = epoch;
    timer = setTimeout(() => {
      timer = null;
      loop(gen);
    }, ms);
  };
  const loop = async (gen) => {
    await pull();
    if (subs.size === 0 || gen !== epoch) return;
    schedule(delay());
  };
  const reschedule = () => {
    if (subs.size === 0) return;
    schedule(0);
  };
  const stop = () => {
    epoch += 1;
    if (timer) clearTimeout(timer);
    timer = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", reschedule);
  };
  const subscribe = (cb) => {
    subs.add(cb);
    if (subs.size === 1) {
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", reschedule);
      schedule(0);
    }
    cb(snapshot);
    return () => {
      if (!subs.delete(cb)) return;
      if (subs.size === 0) stop();
    };
  };
  const markInterrupted = (id) => {
    const at = Date.now();
    interrupted.set(id, at);
    snapshot = { ...snapshot, now: at };
    emit();
  };
  return {
    configure: (getter) => {
      getConnection = getter;
    },
    get: () => snapshot,
    interruptedAt: (id) => interrupted.get(id) ?? null,
    subscribe,
    markInterrupted
  };
}
var runsStore = createRunsStore();
function useRuns() {
  const [snap, setSnap] = import_react.default.useState(() => runsStore.get());
  import_react.default.useEffect(() => runsStore.subscribe(setSnap), []);
  return snap;
}
function useCfg(snap) {
  const [overrides, setOverrides] = import_react.default.useState(readOverrides);
  import_react.default.useEffect(() => {
    const on = () => setOverrides(readOverrides());
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return [{ ...DEFAULTS, ...snap && snap.cfg || {}, ...overrides }, overrides];
}
function useBackends(connection) {
  const [items, setItems] = import_react.default.useState([]);
  const [drivers, setDrivers] = import_react.default.useState([]);
  const load = import_react.default.useCallback(() => {
    rpc(connection, "backends", {}).then((v) => {
      setItems(v?.items || []);
      setDrivers(v?.drivers || []);
    }).catch(() => {
    });
  }, [connection]);
  import_react.default.useEffect(() => {
    load();
  }, [load]);
  return [items, drivers, load];
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1e3));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}
var STATUS = { running: ["运行中", "#d9a400"], completed: ["完成", "#3f9d5a"], error: ["出错", "#e5533c"], aborted: ["已取消", "#8a8a8a"] };
function statusOf(run) {
  return STATUS[run.status] || ["…", "#8a8a8a"];
}
function modelText(run) {
  return run.native ? run.name || "dsh 内置" : run.model || "CLI 默认";
}
function activityOf(run) {
  if (!run?.native) return "";
  if (run.activity === "running" || run.activity === "inactive") return run.activity;
  return run.status === "running" ? "running" : "inactive";
}
function dotColor(run) {
  const activity = activityOf(run);
  if (activity === "running") return STATUS.running[1];
  if (activity === "inactive") return run.status === "error" ? STATUS.error[1] : "#8a8a8a";
  return statusOf(run)[1];
}
function elapsedText(run) {
  if (run.native) {
    if (typeof run.elapsedMs === "number" && Number.isFinite(run.elapsedMs)) return fmtDur(run.elapsedMs);
    if (activityOf(run) === "running") return fmtDur(Date.now() - (run.startedAt || 0));
    return "—";
  }
  return run.status === "running" ? fmtDur(Date.now() - (run.startedAt || 0)) : fmtDur((run.endedAt || 0) - (run.startedAt || 0));
}
function runningRow(run) {
  return Boolean(run) && (run.status === "running" || activityOf(run) === "running");
}
function interruptible(run) {
  return Boolean(run?.native) && activityOf(run) === "running" && run.turnRunning !== false;
}
function nativeRows(snap, projected, scope, sessionId) {
  const rows = Array.isArray(snap?.natives) && snap.natives.length ? snap.natives : projected || [];
  if (scope === "all") return rows;
  if (!sessionId) return [];
  return rows.filter((run) => run.parentId === sessionId);
}
function withNative(external, natives) {
  if (!natives || natives.length === 0) return external;
  const seen = new Set(external.map((run) => run.id));
  return [...external, ...natives.filter((run) => !seen.has(run.id))];
}
function applyInterrupt(run) {
  const at = runsStore.interruptedAt(run.id);
  if (!at || Date.now() - at > INTERRUPT_GRACE_MS) return run;
  if (!runningRow(run)) return run;
  return {
    ...run,
    status: "aborted",
    activity: "inactive",
    endedAt: at,
    elapsedMs: typeof run.elapsedMs === "number" ? run.elapsedMs : run.startedAt ? Math.max(0, at - run.startedAt) : null
  };
}
function interruptNative(connection, sessionId) {
  return rpc(connection, "native-interrupt", { sessionId }).then((value) => {
    if (!value || value.ok === false) throw new Error(value?.error || "中断失败");
    runsStore.markInterrupted(sessionId);
    return value;
  });
}
function statsOf(runs) {
  const out = { total: runs.length, running: 0, completed: 0, error: 0, aborted: 0, costUsd: 0 };
  for (const run of runs) {
    if (run.status === "running") out.running += 1;
    else if (run.status === "completed") out.completed += 1;
    else if (run.status === "error") out.error += 1;
    else if (run.status === "aborted") out.aborted += 1;
    if (typeof run.costUsd === "number") out.costUsd += run.costUsd;
  }
  return out;
}
function scopedRuns(runs, cfg, sessionId) {
  if (cfg.scope === "all") return runs;
  if (!sessionId) return [];
  return runs.filter((run) => run.parentId === sessionId);
}
function lastAction(run) {
  const e = run.lastEvent;
  if (!e) return run.status === "running" ? "启动中…" : "";
  const ic = { tool: "⚙", text: "▸", think: "◎", result: "✔", error: "✖", model: "◆" }[e.kind] || "·";
  return `${ic} ${e.text || ""}`;
}
function nativeRunsFrom(snap, sessionId, scopeAll) {
  if (!snap) return [];
  const byId = snap.byId ?? snap.list?.byId ?? {};
  const bySession = snap.projectionsBySession ?? snap.list?.projectionsBySession ?? {};
  const parents = scopeAll ? Object.keys(bySession) : sessionId ? [sessionId] : [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const parentId of parents) {
    const catalog = bySession[parentId]?.values?.subagentCatalog ?? byId[parentId]?.projections?.subagentCatalog;
    if (!Array.isArray(catalog)) continue;
    for (const item of catalog) {
      if (!item?.id || item.mode === "external" || seen.has(item.id)) continue;
      seen.add(item.id);
      const row = byId[item.id] ?? {};
      const timing = bySession[item.id]?.values?.subagentTiming ?? row.projections?.subagentTiming;
      const active = timing?.active;
      const running = row.running === true || Boolean(active && active.through == null);
      const settled = typeof timing?.settledMs === "number" ? timing.settledMs : null;
      const startedAt = typeof item.createdAt === "number" ? item.createdAt : 0;
      const endedAt = running ? null : typeof row.updatedAt === "number" ? row.updatedAt : startedAt + (settled ?? 0);
      out.push({
        id: item.id,
        // 真实子代理名：投影里有就用，没有回退到占位文案。
        name: item.name || item.agentName || null,
        activity: running ? "running" : "inactive",
        // 运行中不给 elapsedMs，交给界面按 startedAt 实时算；结束的按 settledMs。
        elapsedMs: running ? null : settled ?? (startedAt && endedAt ? Math.max(0, endedAt - startedAt) : null),
        provider: "dsh 内置",
        driver: item.mode || "",
        label: item.label || row.displayTitle || row.projectionValues?.title || row.title || item.id,
        model: null,
        status: running ? "running" : "completed",
        startedAt,
        endedAt,
        costUsd: null,
        native: true,
        stalled: false,
        idleSeconds: active && typeof active.through === "number" ? Math.max(0, Math.round((Date.now() - active.through) / 1e3)) : 0,
        parentId
      });
    }
  }
  return out;
}
function NativeProbe({ hooks, sessionId, scopeAll, onData }) {
  const useSessions = hooks?.useSessions;
  const snap = typeof useSessions === "function" ? useSessions((value) => value) : null;
  const list = import_react.default.useMemo(() => nativeRunsFrom(snap, sessionId, scopeAll), [snap, sessionId, scopeAll]);
  import_react.default.useEffect(() => {
    onData(list);
  }, [list, onData]);
  return null;
}
function useActivity(connection, runId, enabled) {
  const [run, setRun] = import_react.default.useState(null);
  import_react.default.useEffect(() => {
    if (!enabled || !runId) {
      setRun(null);
      return;
    }
    let alive = true;
    const pull = () => rpc(connection, "activity", { runId }).then((v) => {
      if (alive) setRun(v?.run || null);
    }).catch(() => {
    });
    pull();
    const timer = setInterval(pull, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [connection, runId, enabled]);
  return run;
}
function Card({ connection, run, onStop, onInterrupt, stopEnabled, showCost, expanded, onToggle }) {
  const dot = dotColor(run);
  const running = run.status === "running";
  const cost = typeof run.costUsd === "number" && run.costUsd > 0 ? `$${run.costUsd.toFixed(4)}` : "—";
  const effort = run.effort && run.effort !== "auto" ? run.effort : "—";
  const canStop = running && stopEnabled && !run.native;
  const canInterrupt = interruptible(run);
  const detail = useActivity(connection, run.id, expanded);
  return h(
    "div",
    {
      className: "sap-card" + (run.status === "error" ? " sap-err" : run.status === "completed" ? " sap-done" : "") + (expanded ? " sap-expanded" : ""),
      title: expanded ? "点击收起" : run.label || run.prompt || "(任务)",
      onClick: onToggle
    },
    h(
      "div",
      { className: "sap-row" + (showCost ? "" : " sap-nocost") },
      h("span", { className: "sap-dot" + (run.stalled ? " sap-stall" : ""), style: { background: run.stalled ? "#d9a400" : dot } }),
      h("span", { className: "sap-agent", title: run.provider || "" }, run.provider || "?"),
      h("span", { className: "sap-model", title: modelText(run) }, modelText(run)),
      h("span", { className: "sap-effort", title: run.native ? `${activityOf(run) === "running" ? "运行中" : "已结束"}的 dsh 自带子代理` : `强度 ${effort}` }, run.native ? "内置" : effort),
      h("span", { className: "sap-time" }, elapsedText(run)),
      showCost ? h("span", { className: "sap-cost", title: cost === "—" ? "该 CLI 未上报金额" : "成本按 CLI 上报" }, cost) : null,
      h(
        "span",
        { className: "sap-act" },
        canInterrupt ? h("button", { className: "sap-x", title: "中断该内置子代理", onClick: (e) => {
          e.stopPropagation();
          onInterrupt?.(run.id);
        } }, "中断") : canStop ? h("button", { className: "sap-x", title: "停止该子代理", onClick: (e) => {
          e.stopPropagation();
          onStop(run.id);
        } }, "停止") : null
      )
    ),
    expanded ? h(
      "div",
      { className: "sap-detail2" },
      h("div", null, h("b", null, "任务 "), run.label || run.prompt || "—"),
      h("div", null, h("b", null, "最近 "), run.lastEvent ? `${run.lastEvent.kind}: ${run.lastEvent.text}` : "—"),
      (detail?.events || []).slice(-3).map((event, index) => h("div", { key: index, className: "sap-ev2" }, `${event.kind}: ${String(event.text ?? "").slice(0, 160)}`)),
      h("div", null, h("b", null, "会话 "), run.sessionId || "—", " · ", h("b", null, "步骤 "), String(run.eventCount || 0))
    ) : null
  );
}
function Dock({ connection, sessionId, hooks, onOpenTab }) {
  const [hideAt, setHideAt] = import_react.default.useState(readHideAt);
  const [open, setOpen] = import_react.default.useState(false);
  const [pinned, setPinned] = import_react.default.useState(null);
  const [projected, setProjected] = import_react.default.useState([]);
  const [stopError, setStopError] = import_react.default.useState("");
  const snap = useRuns();
  const [cfg] = useCfg(snap);
  const external = scopedRuns(snap.runs || [], cfg, sessionId);
  const all = withNative(external, cfg.includeNative ? nativeRows(snap, projected, cfg.scope, sessionId) : []).map(applyInterrupt);
  const visible = all.filter((run) => (run.startedAt || 0) > hideAt);
  const stats = statsOf(visible);
  const now = Date.now();
  const autoHide = Math.max(0, Number(cfg.autoHideSeconds) || 0);
  const active = visible.filter((run) => runningRow(run));
  const recent = visible.filter((run) => !runningRow(run) && !run.restored && !run.native && autoHide > 0 && now - (run.endedAt || 0) < autoHide * 1e3);
  const shown = [...active, ...recent].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, Math.max(1, Number(cfg.maxCards) || 20));
  const prevActive = import_react.default.useRef(0);
  import_react.default.useEffect(() => {
    if (active.length > prevActive.current) setOpen(true);
    prevActive.current = active.length;
  }, [active.length]);
  import_react.default.useEffect(() => {
    if (!stopError) return;
    const t = setTimeout(() => setStopError(""), 8e3);
    return () => clearTimeout(t);
  }, [stopError]);
  if (!cfg.dock) return null;
  if (cfg.scope === "session" && !sessionId) return null;
  if (shown.length === 0) return null;
  const onStop = (id) => {
    rpc(connection, "stop", { runId: id }).catch(() => {
    });
  };
  const onInterrupt = (id) => {
    setStopError("");
    interruptNative(connection, id).catch((error) => setStopError(`中断失败：${String(error?.message ?? error).slice(0, 80)}`));
  };
  const dismiss = () => {
    const at = Date.now();
    setHideAt(at);
    setOpen(false);
    try {
      window.localStorage.setItem(HIDE_KEY, String(at));
    } catch {
    }
  };
  const summary = [];
  if (stats.running > 0) summary.push(h("span", { key: "r", className: "sap-run" }, `${stats.running} 运行中`));
  else summary.push(h("span", { key: "i", className: "sap-mut" }, "空闲"));
  if (stats.completed) summary.push(h("span", { key: "c", className: "sap-mut" }, `· ${stats.completed} 完成`));
  if (stats.error) summary.push(h("span", { key: "e", className: "sap-errt" }, `· ${stats.error} 出错`));
  if (cfg.showCost && stats.costUsd > 0) summary.push(h("span", { key: "$", className: "sap-mut" }, `· $${stats.costUsd.toFixed(4)}`));
  return h(
    import_react.default.Fragment,
    null,
    cfg.includeNative && !(snap.natives && snap.natives.length) ? h(NativeProbe, { hooks, sessionId, scopeAll: cfg.scope === "all", onData: setProjected }) : null,
    h(
      "div",
      { className: "sap-dock" + (open && shown.length ? "" : " sap-fold") },
      h(
        "div",
        { className: "sap-head" },
        shown.length ? h("span", { className: "sap-care" + (open ? " sap-open" : ""), onClick: () => setOpen((o) => !o), title: open ? "收起" : "展开" }, "▸") : h("span", { className: "sap-care" }, "·"),
        h("span", { className: "sap-h1", onClick: () => shown.length && setOpen((o) => !o) }, "子代理"),
        ...summary,
        h("span", { className: "sap-sp" }),
        h("span", { className: "sap-scope" }, cfg.scope === "session" ? "本会话" : "全部"),
        onOpenTab && sessionId && cfg.tab ? h("button", { className: "sap-open2", title: "在「子代理」页查看全部", onClick: () => onOpenTab(sessionId) }, "↗") : null,
        h("button", { className: "sap-close", title: "隐藏这一行（新运行会再出现）", onClick: dismiss }, "✕")
      ),
      stopError ? h("div", { className: "sap-warn", style: { padding: "0 9px 6px" } }, stopError) : null,
      open && shown.length ? h("div", { className: "sap-cards" }, shown.map((run) => h(Card, {
        key: run.id,
        connection,
        run,
        onStop,
        onInterrupt,
        stopEnabled: cfg.allowStop,
        showCost: cfg.showCost,
        expanded: pinned === run.id,
        onToggle: () => setPinned((id) => id === run.id ? null : run.id)
      }))) : null
    )
  );
}
function Tab({ connection, sessionId, hooks }) {
  const [sel, setSel] = import_react.default.useState(null);
  const [projected, setProjected] = import_react.default.useState([]);
  const [stopError, setStopError] = import_react.default.useState("");
  const [, setTick] = import_react.default.useState(0);
  import_react.default.useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1e3);
    return () => clearInterval(t);
  }, []);
  const snap = useRuns();
  const [cfg] = useCfg(snap);
  import_react.default.useEffect(() => {
    if (!stopError) return;
    const t = setTimeout(() => setStopError(""), 8e3);
    return () => clearTimeout(t);
  }, [stopError]);
  if (!cfg.tab) return null;
  const external = scopedRuns(snap.runs || [], cfg, sessionId);
  const runs = withNative(external, cfg.includeNative ? nativeRows(snap, projected, cfg.scope, sessionId) : []).map(applyInterrupt).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const stats = statsOf(runs);
  const max = Math.max(1, Number(cfg.maxCards) || 20);
  const onStop = (id) => {
    rpc(connection, "stop", { runId: id }).catch(() => {
    });
  };
  const onInterrupt = (id) => {
    setStopError("");
    interruptNative(connection, id).catch((error) => setStopError(`中断失败：${String(error?.message ?? error).slice(0, 80)}`));
  };
  const selRun = sel ? runs.find((r) => r.id === sel) : null;
  return h(
    "div",
    { className: "sap-tab" },
    cfg.includeNative && !(snap.natives && snap.natives.length) ? h(NativeProbe, { hooks, sessionId, scopeAll: cfg.scope === "all", onData: setProjected }) : null,
    h(
      "div",
      { className: "sap-tabhead" },
      h("b", null, "子代理"),
      h("span", { className: "sap-stat" }, `总计 ${stats.total}`),
      h("span", { className: "sap-stat" }, `运行 ${stats.running}`),
      h("span", { className: "sap-stat" }, `完成 ${stats.completed}`),
      h("span", { className: "sap-stat sap-errt" }, `出错 ${stats.error}`),
      cfg.showCost ? h("span", { className: "sap-stat" }, `成本 $${stats.costUsd.toFixed(4)}`) : null,
      h("span", { className: "sap-scope" }, cfg.scope === "session" ? "本会话" : "全部会话"),
      h("span", { className: "sap-scope" }, "管理后端：设置 → 子代理")
    ),
    stopError ? h("div", { className: "sap-warn" }, stopError) : null,
    runs.length === 0 ? h("div", { className: "sap-empty" }, cfg.scope === "session" && !sessionId ? "等待会话加载…" : "暂无子代理运行记录。") : h(
      "table",
      { className: "sap-table" },
      h("thead", null, h("tr", null, ["Agent", "模型", "状态", "耗时", "任务", ""].map((x, i) => h("th", { key: i }, x)))),
      h("tbody", null, runs.slice(0, max).map((run) => {
        const [st] = statusOf(run);
        const col = dotColor(run);
        const running = runningRow(run);
        const canInterrupt = interruptible(run);
        return h(
          "tr",
          { key: run.id, className: "sap-tr", onClick: () => setSel(sel === run.id ? null : run.id) },
          h("td", null, h("b", null, run.provider || "?"), run.native ? h("span", { className: "sap-native", title: run.name ? `dsh 自带子代理：${run.name}` : "dsh 自带的子代理" }, "内置") : null),
          h("td", null, h("span", { className: "sap-model" }, modelText(run))),
          h("td", null, h("span", { style: { color: col, fontWeight: 600 } }, st)),
          h("td", null, elapsedText(run)),
          h("td", { className: "sap-celltask" }, run.label || run.prompt || ""),
          h(
            "td",
            null,
            canInterrupt ? h("button", { className: "sap-x", title: "中断该内置子代理", onClick: (e) => {
              e.stopPropagation();
              onInterrupt(run.id);
            } }, "中断") : running && cfg.allowStop && !run.native ? h("button", { className: "sap-x", onClick: (e) => {
              e.stopPropagation();
              onStop(run.id);
            } }, "停止") : null
          )
        );
      }))
    ),
    selRun ? h(
      "div",
      { className: "sap-detail" },
      h("div", null, h("b", null, "ID "), selRun.id),
      h("div", null, h("b", null, "模型 "), modelText(selRun), " · ", h("b", null, "成本 "), typeof selRun.costUsd === "number" ? `$${selRun.costUsd.toFixed(4)}` : "—", " · ", h("b", null, "步骤 "), `${selRun.eventCount || 0}`),
      h("div", null, h("b", null, "任务 "), selRun.prompt || selRun.label || "—"),
      h("div", null, h("b", null, "最近 "), lastAction(selRun) || "—")
    ) : null
  );
}
var EFFORT_CHOICES = {
  "pi-json": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  "codex-json": ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
};
function BackendAdvanced({ connection, item, onSaved }) {
  const [model, setModel] = import_react.default.useState(item.model || "");
  const [models, setModels] = import_react.default.useState(Array.isArray(item.models) ? item.models : []);
  const [effort, setEffort] = import_react.default.useState(item.reasoningEffort || "auto");
  const [limit, setLimit] = import_react.default.useState(String(item.maxConcurrency || 2));
  const [binary, setBinary] = import_react.default.useState(item.binary || "");
  const [busy, setBusy] = import_react.default.useState(false);
  const [msg, setMsg] = import_react.default.useState("");
  const levels = EFFORT_CHOICES[item.driver] || [];
  const probe = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await rpc(connection, "probe", { name: item.name });
      const list = Array.isArray(r?.models) ? r.models : [];
      setModels(list);
      setMsg(`检测到 ${list.length} 个模型`);
    } catch (error) {
      setMsg(`检测失败：${String(error?.message ?? error).slice(0, 60)}`);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      await rpc(connection, "backend-config", { name: item.name, patch: { model, models, reasoningEffort: effort, maxConcurrency: Number(limit), binary } });
      setMsg("已保存");
      onSaved?.();
    } catch (error) {
      setMsg(`保存失败：${String(error?.message ?? error).slice(0, 60)}`);
    } finally {
      setBusy(false);
    }
  };
  const field = (label, control) => h("label", { className: "sap-field" }, h("span", null, label), control);
  return h(
    "div",
    { className: "sap-adv" },
    h(
      "div",
      { className: "sap-advhead" },
      h("div", { className: "sap-advlab" }, `▾ 高级参数 · ${item.name}`, h("span", null, "后端默认配置")),
      h(
        "div",
        { className: "sap-advact" },
        h("button", { className: "sap-bkbtn", onClick: probe, disabled: busy }, "探测模型"),
        h("button", { className: "sap-bkbtn sap-primary", onClick: save, disabled: busy }, "保存"),
        msg ? h("span", { className: "sap-sethint" }, msg) : null
      )
    ),
    h(
      "div",
      { className: "sap-fields" },
      field("默认模型", h("input", { className: "sap-inp", value: model, placeholder: "留空 = CLI 默认", onChange: (e) => setModel(e.target.value) })),
      levels.length ? field("默认强度", h(
        "select",
        { className: "sap-inp", value: effort, onChange: (e) => setEffort(e.target.value) },
        [["auto", "自动"], ...levels.map((x) => [x, x])].map(([v, l]) => h("option", { key: v, value: v }, l))
      )) : null,
      field("并发上限", h("input", { className: "sap-inp sap-inp-num", value: limit, onChange: (e) => setLimit(e.target.value) })),
      field("二进制路径", h("input", { className: "sap-inp sap-inp-wide", value: binary, placeholder: "留空 = 自动检测", onChange: (e) => setBinary(e.target.value) }))
    ),
    models.length ? h("div", { className: "sap-sethint" }, `可选模型（${models.length}）：${models.slice(0, 12).join(" / ")}${models.length > 12 ? " …" : ""}`) : null
  );
}
function scanCandidates(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : Array.isArray(value?.candidates) ? value.candidates : [];
  const out = [];
  for (const item of list) {
    if (!item) continue;
    if (item.configured === true || item.inUse === true) continue;
    const name2 = String(item.name ?? "").trim();
    const path = String(item.absolutePath ?? item.binary ?? item.path ?? "").trim();
    if (!name2 || !path) continue;
    out.push({
      key: String(item.id ?? `${name2}|${path}`),
      name: name2,
      path,
      driver: String(item.suggestedDriver ?? item.driver ?? ""),
      launchable: item.launchable !== false
    });
  }
  return out;
}
function checkedPathOf(value) {
  return String(value?.absolutePath ?? value?.binary ?? value?.path ?? "").trim();
}
function checkedNoteOf(value) {
  const path = checkedPathOf(value);
  const availability = value?.availability;
  if (availability === "missing" || value?.exists === false || value?.ok === false || !path) {
    return path ? `不可用：${path} 不存在或不能启动` : "没找到可执行文件，请填写绝对路径或可执行命令名";
  }
  if (availability === "unknown") return "无法确认该路径，留到运行时验证";
  if (value?.launchable === false) return `不可启动：${path}`;
  const driver = String(value?.driver ?? "");
  return `已找到可启动入口：${path}${driver ? `（建议 driver：${driver}）` : ""}；登录和协议兼容性在运行时验证`;
}
function Backends({ connection }) {
  const [items, drivers, load] = useBackends(connection);
  const [expanded, setExpanded] = import_react.default.useState("");
  const [pane, setPane] = import_react.default.useState("");
  const [scan, setScan] = import_react.default.useState({ status: "idle", items: [], error: "", note: "" });
  const [picked, setPicked] = import_react.default.useState({});
  const [busy, setBusy] = import_react.default.useState("");
  const [form, setForm] = import_react.default.useState({ name: "", driver: "", binary: "" });
  const [checked, setChecked] = import_react.default.useState({ status: "idle", text: "" });
  const [err, setErr] = import_react.default.useState("");
  const off = items.filter((it) => it.configured && !it.enabled);
  const toggle = async (it) => {
    setErr("");
    try {
      await rpc(connection, "backend", { name: it.name, enabled: !it.enabled });
      load();
    } catch (error) {
      setErr(`切换「${it.name}」失败（${String(error?.message ?? error).slice(0, 80)}）。`);
    }
  };
  const enableAll = async () => {
    setErr("");
    try {
      for (const it of off) await rpc(connection, "backend", { name: it.name, enabled: true });
      load();
    } catch (error) {
      load();
      setErr(`一键启用中断（${String(error?.message ?? error).slice(0, 80)}），已启用的保持生效。`);
    }
  };
  const runScan = async () => {
    setPane("scan");
    setErr("");
    setScan({ status: "loading", items: [], error: "", note: "" });
    try {
      const value = await rpc(connection, "scan", {}, 15e3);
      setScan({
        status: "ready",
        items: scanCandidates(value),
        error: "",
        note: value?.status === "partial" || value?.timedOut ? "部分位置未能检查完，先列出已找到的" : ""
      });
    } catch (error) {
      setScan({ status: "error", items: [], error: `搜索失败：${String(error?.message ?? error).slice(0, 80)}`, note: "" });
    }
  };
  const join = async (cand, driver) => {
    setErr("");
    setBusy(cand.key);
    try {
      await rpc(connection, "backend", { name: cand.name, driver, binary: cand.path, enabled: true });
      setScan((state) => ({ ...state, items: state.items.filter((item) => item.key !== cand.key) }));
      load();
    } catch (error) {
      setErr(`加入「${cand.name}」失败（${String(error?.message ?? error).slice(0, 80)}）。`);
    } finally {
      setBusy("");
    }
  };
  const checkPath = async () => {
    setErr("");
    setChecked({ status: "loading", text: "检测中…" });
    try {
      const value = await rpc(connection, "backend-check", { name: form.name.trim(), binary: form.binary.trim() }, 15e3);
      const path = checkedPathOf(value);
      if (path) setForm((current) => ({ ...current, binary: path }));
      setForm((current) => current.driver || !value?.driver ? current : { ...current, driver: String(value.driver) });
      setChecked({ status: "done", text: checkedNoteOf(value) });
    } catch (error) {
      setChecked({ status: "error", text: `检测失败：${String(error?.message ?? error).slice(0, 80)}` });
    }
  };
  const add = async () => {
    setErr("");
    const name2 = form.name.trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name2)) {
      setErr("名称只能用字母、数字、下划线或短横线（1–32 位）");
      return;
    }
    try {
      await rpc(connection, "backend", { name: name2, enabled: true, driver: form.driver || drivers[0] || "qoder-json", binary: form.binary.trim() });
      setPane("");
      setForm({ name: "", driver: "", binary: "" });
      setChecked({ status: "idle", text: "" });
      load();
    } catch (error) {
      setErr(`添加「${name2}」失败（${String(error?.message ?? error).slice(0, 80)}）。`);
    }
  };
  const toolbar = h(
    "div",
    { className: "sap-setrow" },
    h(
      "div",
      { className: "sap-setlab" },
      h("span", { className: "sap-sethint" }, items.length ? `共 ${items.length} 个后端（本机检测到的 + 已配置的）` : "还没发现本机 CLI，先搜索或手动添加")
    ),
    h(
      "div",
      { className: "sap-setctl" },
      h(
        "button",
        { className: "sap-bkbtn sap-primary", onClick: runScan, disabled: scan.status === "loading" },
        scan.status === "loading" ? "正在扫描…" : "搜索本机 CLI"
      ),
      h("button", { className: "sap-bkbtn", onClick: () => {
        setPane(pane === "manual" ? "" : "manual");
        setErr("");
      } }, "＋ 手动添加")
    )
  );
  const scanPane = pane === "scan" ? h(
    "div",
    { className: "sap-addform" },
    h(
      "div",
      { className: "sap-advrow" },
      h("b", { className: "sap-advlab" }, "本机搜索"),
      scan.status === "ready" ? h("span", { className: "sap-sethint" }, `找到 ${scan.items.length} 项可加入`) : null,
      scan.note ? h("span", { className: "sap-sethint" }, scan.note) : null,
      h("span", { className: "sap-sp" }),
      h("button", { className: "sap-bkbtn", onClick: () => setPane("") }, "收起")
    ),
    scan.status === "loading" ? h("div", { className: "sap-sethint" }, "正在扫描…") : null,
    scan.error ? h("div", { className: "sap-warn" }, scan.error) : null,
    scan.status === "ready" && scan.items.length === 0 ? h("div", { className: "sap-sethint" }, "没找到还没加入的 CLI") : null,
    scan.items.map((cand) => {
      const driver = picked[cand.key] || cand.driver;
      return h(
        "div",
        { className: "sap-setrow sap-scanrow", key: cand.key },
        h(
          "div",
          { className: "sap-setlab sap-scanlab" },
          h("b", null, cand.name),
          h("div", { className: "sap-scanpath" }, cand.path),
          cand.driver ? h("div", { className: "sap-sethint" }, `建议 driver：${cand.driver}`) : h("div", { className: "sap-sethint" }, "未识别 driver，需手动选择")
        ),
        h(
          "div",
          { className: "sap-setctl" },
          cand.driver ? null : h(
            "select",
            {
              className: "sap-inp",
              value: picked[cand.key] || "",
              onChange: (e) => setPicked({ ...picked, [cand.key]: e.target.value })
            },
            h("option", { value: "" }, "选择 driver…"),
            drivers.map((d) => h("option", { key: d, value: d }, d))
          ),
          h("button", {
            className: "sap-bkbtn sap-primary",
            disabled: !driver || busy === cand.key || cand.launchable === false,
            title: cand.launchable === false ? "该路径不能启动" : "加入并启用",
            onClick: () => join(cand, driver)
          }, busy === cand.key ? "加入中…" : "加入")
        )
      );
    })
  ) : null;
  const manualPane = pane === "manual" ? h(
    "div",
    { className: "sap-addform" },
    h(
      "div",
      { className: "sap-advrow" },
      h("b", { className: "sap-advlab" }, "手动添加"),
      h("span", { className: "sap-sethint" }, "driver 决定启动参数和 JSON 协议，须与 CLI 实际协议一致"),
      h("span", { className: "sap-sp" }),
      h("button", { className: "sap-bkbtn", onClick: () => {
        setPane("");
        setErr("");
        setChecked({ status: "idle", text: "" });
      } }, "取消")
    ),
    h(
      "div",
      { className: "sap-advrow" },
      h("input", { className: "sap-inp", placeholder: "名称，如 codebuddy2", value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) }),
      h(
        "select",
        { className: "sap-inp", value: form.driver || drivers[0] || "", onChange: (e) => setForm({ ...form, driver: e.target.value }) },
        drivers.map((d) => h("option", { key: d, value: d }, d))
      ),
      h("input", {
        className: "sap-inp sap-inp-wide",
        placeholder: "CLI 路径（可留空自动检测）",
        value: form.binary,
        onChange: (e) => {
          setForm({ ...form, binary: e.target.value });
          setChecked({ status: "idle", text: "" });
        }
      }),
      h("button", { className: "sap-bkbtn", onClick: checkPath, disabled: checked.status === "loading" }, "检测"),
      h("button", { className: "sap-bkbtn sap-primary", onClick: add }, "添加")
    ),
    checked.text ? h("div", { className: checked.status === "error" ? "sap-warn" : "sap-sethint" }, checked.text) : null
  ) : null;
  return h(
    "div",
    { className: "sap-group sap-backends" },
    h("div", { className: "sap-gtitle" }, "后端"),
    h("div", { className: "sap-sethint" }, "只列这台机器检测到的和已配置的 CLI；加入、改路径都在这里"),
    toolbar,
    scanPane,
    manualPane,
    items.map((it) => h(
      import_react.default.Fragment,
      { key: it.name },
      h(
        "div",
        { className: "sap-setrow" },
        h(
          "div",
          { className: "sap-setlab" },
          h(
            "span",
            { className: "sap-link", onClick: () => setExpanded(expanded === it.name ? "" : it.name) },
            `${expanded === it.name ? "▾" : "▸"} `,
            h("b", null, it.name)
          ),
          it.guide ? h("div", { className: "sap-sethint" }, it.guide) : null,
          it.configured && !it.enabled ? h("div", { className: "sap-sethint" }, "已停用；模型、强度、并发等设置保留") : null
        ),
        h(
          "div",
          { className: "sap-setctl" },
          it.installed ? h("span", { className: "sap-detected" }, "已检测到") : h("span", { className: "sap-missed" }, "未检测到"),
          expanded === it.name ? h("span", { className: "sap-sethint" }, "参数见下方") : null,
          h("button", {
            className: "sap-pill" + (it.enabled ? " sap-on" : ""),
            role: "switch",
            "aria-checked": it.enabled ? "true" : "false",
            onClick: () => toggle(it)
          }, h("span"))
        )
      ),
      expanded === it.name && it.enabled ? h(BackendAdvanced, { connection, item: it, onSaved: load }) : null
    )),
    off.length ? h(
      "div",
      { className: "sap-setrow" },
      h("div", { className: "sap-setlab" }),
      h(
        "div",
        { className: "sap-setctl" },
        h("button", { className: "sap-bkbtn", onClick: enableAll }, "一键启用已停用后端")
      )
    ) : null,
    err ? h("div", { className: "sap-warn" }, err) : null
  );
}
function Settings({ connection }) {
  const snap = useRuns();
  const [cfg, overrides] = useCfg(snap);
  const [note, setNote] = import_react.default.useState("");
  const runs = snap.runs || [];
  const stats = statsOf(runs);
  const persist = async (patch) => {
    try {
      if (patch.reset === true) {
        await rpc(connection, "panel", { reset: true });
        writeOverrides({});
      } else {
        for (const [key, value] of Object.entries(patch)) await rpc(connection, "panel", { key, value });
        const next = { ...overrides };
        for (const key of Object.keys(patch)) delete next[key];
        if (Object.keys(next).length === 0) writeOverrides({});
        else writeOverrides(next);
      }
      setNote("");
    } catch (error) {
      const next = { ...overrides };
      for (const [key, value] of Object.entries(patch)) if (key !== "reset") next[key] = value;
      writeOverrides(next);
      setNote(`写回配置失败（${String(error?.message ?? error).slice(0, 80)}），已改为本地生效。`);
    }
  };
  const dirty = Object.keys(overrides).filter((key) => key in DEFAULTS);
  const row = (label, hint, control, key) => h(
    "div",
    { className: "sap-setrow" },
    h("div", { className: "sap-setlab" }, label, hint ? h("div", { className: "sap-sethint" }, hint) : null),
    h("div", { className: "sap-setctl" }, control),
    dirty.includes(key) ? h("span", { className: "sap-over", title: "写回配置失败，当前值只在本机生效" }) : null
  );
  const group = (title, children) => h(
    "div",
    { className: "sap-group" },
    h("div", { className: "sap-gtitle" }, title),
    children
  );
  const toggle = (key) => h("button", {
    className: "sap-pill" + (cfg[key] ? " sap-on" : ""),
    role: "switch",
    "aria-checked": cfg[key] ? "true" : "false",
    onClick: () => persist({ [key]: !cfg[key] })
  }, h("span"));
  const seg = (key, options, cast) => h("div", { className: "sap-seg" }, options.map(([value, label]) => h("button", {
    key: value,
    className: "sap-segbtn" + (String(cfg[key]) === value ? " sap-seg-on" : ""),
    onClick: () => persist({ [key]: cast ? cast(value) : value })
  }, label)));
  return h(
    "div",
    { className: "sap-settings" },
    h(
      "div",
      { className: "sap-statbar" },
      h("span", null, "总计 ", h("b", null, stats.total)),
      h("span", { className: "sap-dotsep" }, "·"),
      h("span", { className: "sap-run" }, "运行 ", h("b", null, stats.running)),
      h("span", { className: "sap-dotsep" }, "·"),
      h("span", { className: "sap-donet" }, "完成 ", h("b", null, stats.completed)),
      h("span", { className: "sap-dotsep" }, "·"),
      h("span", { className: "sap-errt" }, "出错 ", h("b", null, stats.error)),
      cfg.showCost ? h("span", null, `· 成本 $${stats.costUsd.toFixed(4)}`) : null
    ),
    h(Backends, { connection }),
    h(
      "div",
      { className: "sap-cols" },
      h(
        "div",
        { className: "sap-col" },
        group("入口", [
          row("输入框上方 dock", "有运行或有完成记录时才出现", toggle("dock"), "dock"),
          row("「子代理」标签页", "关掉后运行详情只能从 dock 进", toggle("tab"), "tab")
        ]),
        group("显示", [
          row("范围", "", seg("scope", [["session", "本会话"], ["all", "全部"]]), "scope"),
          row("卡片上限", "", seg("maxCards", [["10", "10"], ["20", "20"], ["40", "40"]], Number), "maxCards"),
          row("完成卡片收起", "", seg("autoHideSeconds", [["0", "不自动"], ["10", "10s"], ["30", "30s"], ["60", "60s"], ["300", "5m"]], Number), "autoHideSeconds"),
          row("显示成本", "金额来自 CLI 上报", toggle("showCost"), "showCost")
        ])
      ),
      h(
        "div",
        { className: "sap-col" },
        group("操作", [
          row("停止按钮（kill 进程）", "", toggle("allowStop"), "allowStop")
        ]),
        group("数据", [
          row("并入 dsh 内置子代理", "只读、带「内置」标", toggle("includeNative"), "includeNative")
        ])
      )
    ),
    note ? h("div", { className: "sap-warn" }, note) : null,
    h(
      "div",
      { className: "sap-foot" },
      h("span", { className: "sap-note" }, "改完立即生效，并写回本插件配置的 panel 节点（cordis.patch.yml）。"),
      h("button", { className: "sap-reset", onClick: () => persist({ reset: true }) }, "恢复默认")
    )
  );
}
var PANEL_STYLE = `
.sap-dock { margin: 4px 0 2px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; font-size: 12px; }
.sap-head { display: flex; align-items: center; gap: 6px; padding: 4px 9px; user-select: none; }
.sap-care { display: inline-block; transition: transform .15s; color: var(--dsw-alias-brand-primary); cursor: pointer; width: 10px; }
.sap-care.sap-open { transform: rotate(90deg); }
.sap-h1 { font-weight: 600; cursor: pointer; }
.sap-run { color: var(--dsw-alias-brand-primary); font-weight: 600; }
.sap-mut { color: var(--dsw-alias-label-secondary); }
.sap-errt { color: #e5533c; }
.sap-sp { flex: 1; }
.sap-scope { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.sap-close { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; line-height: 1; padding: 2px 4px; border-radius: 5px; }
.sap-close:hover { background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); }
/* dock 卡片：单列、固定列宽（状态点 / 后端 / 模型 / 强度 / 耗时 / 成本 / 操作），缺值也不让右侧漂移 */
.sap-cards { display: flex; flex-direction: column; gap: 4px; padding: 0 8px 7px; max-height: 180px; overflow-y: auto; }
.sap-card { border: 1px solid var(--dsw-alias-border-l2); border-left: 2px solid var(--dsw-alias-brand-primary); border-radius: 7px; padding: 1px 8px; background: var(--dsw-alias-bg-layer-2); }
.sap-card.sap-done { border-left-color: #3f9d5a; }
.sap-card.sap-err { border-left-color: #e5533c; }
.sap-row { display: grid; align-items: center; gap: 6px; height: 24px; grid-template-columns: 8px 56px minmax(0, 1fr) 44px 46px 64px 44px; }
.sap-row.sap-nocost { grid-template-columns: 8px 56px minmax(0, 1fr) 44px 46px 44px; }
.sap-dot { width: 7px; height: 7px; border-radius: 50%; }
.sap-dot.sap-stall { animation: sap-blink 1.2s ease-in-out infinite; }
@keyframes sap-blink { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.sap-agent { font-weight: 600; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sap-native { font-size: 9.5px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
.sap-model { font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); color: var(--dsw-alias-brand-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; justify-self: start; max-width: 100%; }
.sap-effort { font-size: 10px; line-height: 16px; text-align: center; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); overflow: hidden; white-space: nowrap; }
.sap-time { text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.sap-cost { text-align: right; font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.sap-act { display: flex; justify-content: flex-end; }
.sap-x { font-size: 10px; line-height: 16px; padding: 0 7px; border-radius: 5px; border: 1px solid color-mix(in srgb, #e5533c 45%, transparent); color: #e5533c; background: transparent; cursor: pointer; white-space: nowrap; }
.sap-x:hover { background: color-mix(in srgb, #e5533c 10%, transparent); }
/* 卡片就地展开的详情 */
.sap-card { cursor: pointer; }
.sap-card.sap-expanded { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, transparent); }
.sap-detail2 { padding: 2px 4px 6px 14px; display: flex; flex-direction: column; gap: 2px; color: var(--dsw-alias-label-secondary); font-size: 11px; overflow-wrap: anywhere; }
.sap-detail2 b { color: var(--dsw-alias-label-primary); font-weight: 600; margin-right: 2px; }
.sap-detail2 .sap-ev2 { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; opacity: .85; }
.sap-open2 { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 0 3px; cursor: pointer; }
.sap-open2:hover { color: var(--dsw-alias-brand-primary); }
/* 插件页的指路条 + 设置页里的只读原始配置（已随 1.1.24 合并删除，保留占位注释便于追溯） */
.sap-tab { padding: 12px 16px; font-size: 13px; }
.sap-tabhead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.sap-tabhead b { font-size: 15px; }
.sap-stat { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.sap-table { width: 100%; border-collapse: collapse; }
.sap-table th, .sap-table td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; }
.sap-table th { color: var(--dsw-alias-label-secondary); font-weight: 500; font-size: 12px; }
.sap-tr { cursor: pointer; }
.sap-tr:hover { background: var(--dsw-alias-bg-overlay); }
.sap-celltask { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.sap-detail { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 1.7; word-break: break-all; }
.sap-empty { padding: 18px; color: var(--dsw-alias-label-secondary); }
.sap-settings { border-top: 1px solid var(--dsw-alias-border-l2); margin-top: 6px; padding-top: 4px; }
.sap-stats { display: flex; gap: 14px; flex-wrap: wrap; padding: 8px 0 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.sap-group { padding: 2px 0 6px; }
.sap-gtitle { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); padding: 8px 0 2px; }
.sap-setrow { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.sap-group .sap-setrow:last-child { border-bottom: 0; }
.sap-setlab { color: var(--dsw-alias-label-primary); font-size: 13px; }
.sap-sethint { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 1px; }
.sap-setctl { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.sap-over { width: 6px; height: 6px; border-radius: 50%; background: #d9a400; }
.sap-pill { width: 38px; height: 21px; border-radius: 999px; border: none; background: var(--dsw-alias-border-l3); position: relative; cursor: pointer; padding: 0; transition: background .15s; }
.sap-pill.sap-on { background: #3f9d5a; }
.sap-pill span { position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%; background: #fff; transition: left .15s; }
.sap-pill.sap-on span { left: 19px; }
.sap-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; overflow: hidden; }
.sap-segbtn { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11.5px; padding: 3px 9px; cursor: pointer; }
.sap-segbtn + .sap-segbtn { border-left: 1px solid var(--dsw-alias-border-l2); }
.sap-segbtn.sap-seg-on { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.sap-foot { display: flex; align-items: center; gap: 10px; padding: 10px 0 4px; }
.sap-reset { margin-left: auto; font-size: 11.5px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.sap-reset:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-overlay); }
.sap-note { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.sap-warn { color: #d9a400; font-size: 11px; padding: 6px 0; }
/* 「后端」分组：与下方运行面板分组用一条分隔线隔开，折叠标题可点。 */
.sap-backends { border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 10px; margin-bottom: 2px; }
.sap-link { cursor: pointer; color: var(--dsw-alias-label-secondary); }
.sap-link:hover { color: var(--dsw-alias-label-primary); }
.sap-bkbtn { font-size: 11.5px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; }
.sap-bkbtn:hover { background: var(--dsw-alias-bg-overlay); }
.sap-bkbtn.sap-primary { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); color: var(--dsw-alias-brand-primary); }
/* 后端搜索候选：名字 / 绝对路径 / 建议 driver / 加入 */
.sap-scanrow { align-items: flex-start; }
.sap-scanlab { min-width: 0; flex: 1; }
.sap-scanpath { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.sap-missed { color: var(--dsw-alias-label-secondary); font-size: 10px; opacity: .55; }
/* 设置页：统计条、两列分组、后端徽标、高级参数块 */
.sap-statbar { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; height: 32px; padding: 0 12px; margin: 2px 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.sap-statbar b { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; margin-left: 4px; }
.sap-statbar .sap-dotsep { color: var(--dsw-alias-border-l3); }
.sap-donet { color: #7cbc8e; }
.sap-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 26px; }
.sap-col { min-width: 0; }
.sap-detected { color: var(--dsw-alias-label-secondary); font-size: 10px; opacity: .8; }
.sap-advhead { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sap-advlab { font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.sap-advlab span { font-weight: 400; color: var(--dsw-alias-label-secondary); margin-left: 6px; }
.sap-advact { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.sap-fields { display: grid; grid-template-columns: 1.15fr .8fr .6fr 1.5fr; gap: 9px; align-items: end; }

.sap-subtabs { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; overflow: hidden; margin: 2px 0 6px; }
.sap-subtab { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 4px 14px; cursor: pointer; }
.sap-subtab-on { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color: var(--dsw-alias-brand-primary); }
/* 后端高级参数与添加表单 */
.sap-adv { margin: 4px 0 10px; padding: 9px 10px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; }
.sap-addform { margin: 6px 0 10px; padding: 9px 10px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; }
.sap-advrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.sap-field { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.sap-inp { font-size: 11.5px; padding: 3px 7px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); min-width: 120px; }
.sap-inp-num { min-width: 56px; width: 56px; }
.sap-inp-wide { min-width: 210px; }
.sap-inp:focus { outline: 1px solid var(--dsw-alias-brand-primary); }
`;
function registerPanel(ctx) {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.pluginPanel = "dsh-cli-hub-panel";
    tag.textContent = PANEL_STYLE;
    document.head.append(tag);
    return () => tag.remove();
  }, "dsh-cli-hub: panel styles");
  const connection = () => ctx.get("connection");
  runsStore.configure(connection);
  const openTab = (sessionId) => {
    try {
      ctx.get("uiConversation")?.binding?.(sessionId)?.activate?.("subagent-run-tab");
    } catch {
    }
  };
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "subagent-run-dock",
    order: 40
  }, (props) => h(Dock, {
    connection: connection(),
    sessionId: props?.sessionId ?? props?.session?.id ?? null,
    hooks: props,
    onOpenTab: openTab
  })));
  ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "subagent-run-tab",
    order: 40,
    label: () => "子代理"
  }, (props) => h(Tab, {
    connection: connection(),
    sessionId: props?.sessionId ?? props?.session?.id ?? null,
    hooks: props
  })));
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "dsh-cli-hub",
    order: 17,
    label: () => "子代理"
  }, () => h(Settings, { connection: connection() })));
}

var name = "dsh-cli-hub-client";
var inject = ["slots", "locale", "configForms", "connection"];
var LOCALE_NS = "settings.dshCliSubagent";
var LOCALES = {
  zh: { meta: { title: "自由子代理", description: "把任务委派给本机已登录的外部 CLI 子代理,消耗各自会员额度。" }, nav: "自由子代理" },
  en: { meta: { title: "Free Subagents", description: "Delegate tasks to local external CLI subagents and spend their subscription quotas." }, nav: "Free Subagents" }
};
var STYLE = `
.qsub-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.qsub-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.qsub-field { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; min-height: 32px; }
.qsub-label { width: 130px; flex: none; color: var(--dsw-alias-label-primary); opacity: .7; font-size: 13px; }
.qsub-control { height: 32px; padding: 0 10px; border-radius: 8px; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13px; outline: none; transition: border-color .15s, box-shadow .15s; }
.qsub-control:hover { border-color: var(--dsw-alias-border-l3); }
.qsub-control:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.qsub-control:disabled { opacity: .45; cursor: not-allowed; background: var(--dsw-alias-bg-overlay); }
.qsub-btn:disabled { opacity: .45; cursor: not-allowed; }
.qsub-control::placeholder { color: var(--dsw-alias-label-primary); opacity: .35; }
.qsub-select { min-width: 220px; padding-right: 6px; }
.qsub-number { width: 140px; }
.qsub-path { width: 380px; max-width: 100%; }
.qsub-btn { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; transition: background .15s, border-color .15s; }
.qsub-btn:hover { background: var(--dsw-alias-bg-overlay); border-color: var(--dsw-alias-border-l3); }
.qsub-hint { color: var(--dsw-alias-label-primary); opacity: .55; font-size: 12px; }
.qsub-ok { color: #3f9d5a; }
.qsub-bad { color: #e5533c; }
.qsub-mono { font-family: ui-monospace, Consolas, monospace; }
.qsub-toolbar { display: flex; justify-content: flex-end; gap: 6px; margin-bottom: 10px; }
.qsub-active-btn { background: var(--dsw-alias-bg-overlay); border-color: var(--dsw-alias-border-l3); font-weight: 600; }
.qsub-tabs { display: flex; gap: 2px; margin-bottom: 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.qsub-tab { background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 8px 14px; color: var(--dsw-alias-label-primary); opacity: .6; font-size: 13px; cursor: pointer; }
.qsub-tab:hover { opacity: .85; }
.qsub-tab-on { opacity: 1; font-weight: 600; border-bottom-color: var(--dsw-alias-brand-primary); }
.qsub-model-list { flex: 1; min-width: 0; }
.qsub-model-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
.qsub-model-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qsub-model-rate { font-size: 12px; opacity: .55; flex: none; }
.qsub-icon-btn { width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12px; line-height: 1; }
.qsub-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-overlay); }
.qsub-icon-btn:disabled { opacity: .3; cursor: not-allowed; }
.qsub-modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 3000; }
.qsub-toast { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l3); border-radius: 10px; padding: 10px 20px; font-size: 15px; font-weight: 700; box-shadow: 0 8px 24px rgba(0,0,0,.18); z-index: 3100; }
.qsub-modal { width: 520px; max-width: calc(100vw - 40px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 20px; box-shadow: 0 10px 40px rgba(0,0,0,.25); }
`;
var BUILTIN_BACKENDS = [
  { name: "qoder", driver: "qoder-json" },
  { name: "qodercn", driver: "qoder-json" },
  { name: "opencode", driver: "opencode-json" },
  { name: "pi", driver: "pi-json" },
  { name: "codebuddy", driver: "codebuddy-json" },
  { name: "codex", driver: "codex-json" },
  { name: "claude", driver: "claude-json" }
];
var RESUME_COMMANDS = {
  qoder: (id) => `qodercli --resume ${id}`,
  qodercn: (id) => `qoderclicn --resume ${id}`,
  codebuddy: (id) => `codebuddy --resume ${id}`,
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`
};
var h2 = import_react2.default.createElement;
function callRpc(connection, endpoint, payload, timeout = 6e4) {
  return connection.rpc.call("/api", `dsh-cli-hub/${endpoint}`, payload, AbortSignal.timeout(timeout)).then((result) => {
    if (!result?.ok) throw new Error(result?.error?.message ?? "probe failed");
    return result.value;
  });
}
function QoderToolView({ block, connection }) {
  const settled = block?.kind === "tool-result";
  const resultText = settled ? (block.content ?? []).find?.((item) => item?.type === "text")?.text ?? "" : "";
  const runId = /started subagent ([0-9a-fA-F-]{36})/.exec(resultText)?.[1];
  const [run, setRun] = import_react2.default.useState(null);
  const [open, setOpen] = import_react2.default.useState(false);
  const [, setTick] = import_react2.default.useState(0);
  const bodyRef = import_react2.default.useRef(null);
  const running = Boolean(runId) && (!run || run.status === "running");
  import_react2.default.useEffect(() => {
    if (!runId || !connection) return;
    let alive = true;
    const poll = async () => {
      try {
        const next = await callRpc(connection, "activity", { runId });
        if (alive) setRun(next.run ?? null);
      } catch {
      }
    };
    poll();
    const timer = setInterval(poll, 2e3);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [runId, connection]);
  import_react2.default.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((x) => x + 1), 1e3);
    return () => clearInterval(timer);
  }, [running]);
  import_react2.default.useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [open, run?.events?.length]);
  if (!settled) return h2("div", { style: { opacity: 0.6, fontSize: 13 } }, "正在启动子代理…");
  if (!runId) return h2("div", { style: { fontSize: 13 } }, resultText || "子代理");
  const status = run?.status ?? "running";
  const seconds = run ? Math.max(0, Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1e3)) : 0;
  const badge = { running: ["运行中", "#b8860b"], completed: ["已完成", "#3f9d5a"], error: ["出错", "#e5533c"], aborted: ["已取消", "#8a8a8a"] }[status] ?? ["…", "#8a8a8a"];
  const allEvents = run?.events ?? [];
  const shown = open ? allEvents : allEvents.slice(-6);
  const kindIcon = { tool: "⚙", text: "▸", think: "◎", result: "✔", error: "✖" };
  const creditsText = run?.credits ? run.credits.total > 0 ? `${run.credits.total.toFixed(4)} 额度` : run.credits.billable === false ? "免费" : "0 额度" : typeof run?.costUsd === "number" ? `$${run.costUsd.toFixed(4)}` : null;
  const idleSeconds = run && running ? Math.max(0, Math.round((Date.now() - (allEvents.at(-1)?.t ?? run.startedAt)) / 1e3)) : 0;
  const stallLimit = run?.stallWarnSeconds ?? 90;
  const stalled = running && stallLimit > 0 && idleSeconds >= stallLimit;
  return h2(
    "div",
    { style: { fontSize: 13, lineHeight: 1.5 } },
    h2(
      "div",
      {
        style: { display: "flex", gap: 8, alignItems: "baseline", cursor: "pointer", userSelect: "none" },
        onClick: () => setOpen((x) => !x),
        title: open ? "收起详情" : "展开全部过程"
      },
      h2("span", { style: { display: "inline-block", transform: `rotate(${open ? 90 : 0}deg)`, transition: "transform .15s" } }, "▸"),
      h2("span", { style: { fontWeight: 600 } }, run?.provider ?? "qoder"),
      h2("span", { style: { color: badge[1] } }, badge[0]),
      h2("span", { style: { opacity: 0.55 } }, `${seconds}s`),
      stalled ? h2("span", { style: { color: "#e5533c" } }, `· 静默 ${idleSeconds}s`) : null,
      creditsText ? h2("span", { style: { opacity: 0.55 } }, `· ${creditsText}`) : null,
      run?.label ? h2("span", { style: { opacity: 0.55 } }, `· ${run.label}`) : null,
      h2("span", { style: { opacity: 0.45, marginLeft: "auto" } }, `${allEvents.length} 步`)
    ),
    shown.length > 0 && h2(
      "div",
      {
        ref: bodyRef,
        style: {
          marginTop: 4,
          paddingLeft: 10,
          borderLeft: "2px solid rgba(128,128,128,0.25)",
          maxHeight: open ? 420 : "none",
          overflowY: open ? "auto" : "hidden"
        }
      },
      shown.map((event, index) => h2("div", {
        key: index,
        style: {
          whiteSpace: open ? "pre-wrap" : "nowrap",
          overflow: open ? "visible" : "hidden",
          textOverflow: open ? void 0 : "ellipsis",
          maxWidth: 620,
          fontFamily: event.kind === "tool" ? "ui-monospace, Consolas, monospace" : void 0,
          opacity: event.kind === "think" ? 0.7 : 0.9
        }
      }, `${kindIcon[event.kind] ?? "·"} ${event.text}`)),
      open && run?.sessionId && RESUME_COMMANDS[run.provider] && h2(
        "div",
        { style: { marginTop: 8, opacity: 0.55, fontSize: 12 } },
        "完整记录已存 CLI 会话: ",
        h2("code", null, RESUME_COMMANDS[run.provider](run.sessionId))
      )
    )
  );
}
function SectionIcon(props) {
  const size = Number(props?.size) > 0 ? Number(props.size) : 16;
  return h2(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
      display: "block"
    },
    h2("circle", { cx: 8, cy: 3.5, r: 2 }),
    h2("path", { d: "M8 5.5V7.5M4 7.5h8M4 7.5v2M12 7.5v2" }),
    h2("circle", { cx: 4, cy: 11.5, r: 2 }),
    h2("circle", { cx: 12, cy: 11.5, r: 2 })
  );
}
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, LOCALES), "dsh-cli-hub: copy");
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-cli-hub";
    tag.textContent = STYLE;
    document.head.append(tag);
    return () => tag.remove();
  }, "dsh-cli-hub: styles");
  for (const toolName of BUILTIN_BACKENDS.map((backend) => backend.name)) {
    ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
      name: "tool.call.toolview",
      key: toolName,
      locale: LOCALE_NS,
      inject: () => ({ connection: ctx.get("connection") })
    }, QoderToolView));
  }
  registerPanel(ctx);
  try {
    ctx.slots.inject("settings.section.icon", () => {
      try {
        return ctx.slots.register({ name: "settings.section.icon", id: "dsh-cli-hub", order: 17 }, SectionIcon);
      } catch (error) {
        console.warn("[dsh-cli-hub] 设置分区图标注册失败，保留默认齿轮", error);
        return void 0;
      }
    });
  } catch (error) {
    console.warn("[dsh-cli-hub] settings.section.icon 槽位不可用，保留默认齿轮", error);
  }
}
		})(module, module.exports);
		return module.exports;
	},
});

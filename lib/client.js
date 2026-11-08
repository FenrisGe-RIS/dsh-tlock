window.__ModuleLoader__.load({
  id: "dsh-tlock",
  factory: (require) => {
    const React = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const el = React.createElement;

    const ROUTE = "/dsh-tlock";
    const POLL_MS = 2000;
    const STORAGE_BALL = "dsh-tlock:ball-pos";

    // ── 纯函数：格式化 ───────────────────────────────────────────────
    function trim(s) {
      return s.indexOf(".") >= 0 ? s.replace(/\.?0+$/u, "") : s;
    }
    // 当前界面语言：中文用「万 / 亿」，英文用 K / M / B
    let LANG = "zh";

    function fmtTok(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return "?";
      if (LANG === "en") {
        if (v >= 1000000000) return trim((v / 1000000000).toFixed(1)) + "B";
        if (v >= 1000000) return trim((v / 1000000).toFixed(v >= 10000000 ? 0 : 1)) + "M";
        if (v >= 1000) return trim((v / 1000).toFixed(v >= 100000 ? 0 : 1)) + "K";
        return String(Math.round(v));
      }
      if (v >= 100000000) return trim((v / 100000000).toFixed(2)) + "亿";
      if (v >= 10000) return trim((v / 10000).toFixed(v >= 100000 ? 0 : 1)) + "万";
      return String(Math.round(v));
    }
    function fmtTime(sec) {
      const v = Math.max(0, Math.round(Number(sec) || 0));
      if (LANG === "en") {
        if (v < 60) return v + "s";
        const em = Math.floor(v / 60);
        const es = v % 60;
        if (em < 60) return es === 0 ? em + "m" : em + "m " + es + "s";
        const eh = Math.floor(em / 60);
        const emm = em % 60;
        return emm === 0 ? eh + "h" : eh + "h " + emm + "m";
      }
      if (v < 60) return v + " 秒";
      const m = Math.floor(v / 60);
      const s = v % 60;
      if (m < 60) return s === 0 ? m + " 分" : m + " 分 " + s + " 秒";
      const h = Math.floor(m / 60);
      const mm = m % 60;
      return mm === 0 ? h + " 小时" : h + " 小时 " + mm + " 分";
    }
    function fmtClock(ms) {
      const v = Math.max(0, Math.round(Number(ms) || 0));
      const total = Math.floor(v / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return (m < 10 ? "0" + m : String(m)) + ":" + (s < 10 ? "0" + s : String(s));
    }

    // ── 滑条：分段映射 + 刻度吸附 ─────────────────────────────────────
    // stops 是 6 个"整点"（含最小与最大），把滑条均分成 5 段，刻度正好落在 1/5…4/5。
    function posToValue(stops, pos) {
      const p = Math.max(0, Math.min(1, pos));
      const segs = stops.length - 1;
      const raw = p * segs;
      const i = Math.min(segs - 1, Math.floor(raw));
      const t = raw - i;
      // 段内用等比插值，手感更像"指数调节"
      const a = stops[i];
      const b = stops[i + 1];
      const value = a * Math.pow(b / a, t);
      return Math.round(value);
    }
    function valueToPos(stops, value) {
      const v = Math.max(stops[0], Math.min(stops[stops.length - 1], Number(value) || stops[0]));
      const segs = stops.length - 1;
      for (let i = 0; i < segs; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        if (v <= b || i === segs - 1) {
          const t = Math.log(v / a) / Math.log(b / a);
          return Math.max(0, Math.min(1, (i + Math.max(0, Math.min(1, t))) / segs));
        }
      }
      return 1;
    }
    function nearestStopPos(pos, stops) {
      const segs = stops.length - 1;
      const raw = pos * segs;
      const snapped = Math.round(raw) / segs;
      const dist = Math.abs(raw - Math.round(raw));
      return { pos: snapped, near: dist <= 0.075 };
    }

    const TOKEN_STOPS = [5000, 50000, 200000, 400000, 700000, 1000000];
    const TIME_STOPS = [60, 600, 1800, 3600, 5400, 7200];

    // ── 文案 ─────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        title: "T约束",
        sub: "每轮生成的 token / 时间双闸",
        tabMain: "约束模式",
        tabHistory: "查看历史归档记录",
        tabSettings: "设置",
        token: "Token 上限",
        time: "时间上限",
        thisRound: "本轮已用",
        noRound: "还没有开始计量的一轮",
        custom: "手动输入",
        customToken: "这一轮最多多少 token",
        customTime: "这一轮最多多少分钟",
        confirm: "确定",
        cancel: "取消",
        archive: "归档",
        archiveOn: "开启归档",
        archiveOff: "取消归档",
        modeBrief: "简洁描述",
        modeFull: "归档完全记录",
        modeBoth: "两个都要",
        recommended: "推荐",
        modeHint: {
          brief: "给人看的：一眼知道这轮在说什么，并写清这份省略了什么",
          full: "一字不落：完整思考、全部工具参数与返回、正文原文都在",
          both: "两份都写，费一点磁盘",
        },
        rename: "重命名",
        renameSave: "保存",
        renameCancel: "取消",
        renameHint: "新的名字（时间前缀会保留）",
        openInFolder: "在文件夹中显示",
        back: "返回",
        fileEmpty: "（这份文件是空的）",
        fileBinary: "（这个文件是二进制/过大，需要到文件夹里看）",
        renamed: "已重命名",
        renameFailed: "改名字失败",
        loadFailed: "读取归档失败（旧版本插件没有这个接口，重启 DSH 即可）",
        running: "约束中",
        paused: "已暂停",
        offline: "DSH 未连接",
        awaiting: "到量，已硬断",
        continueGen: "继续生成",
        endRound: "结束本轮",
        stopNow: "到此为止",
        historyEmpty: "还没有归档记录。开启归档后，每一轮结束都会留一份。",
        openFolder: "打开归档目录",
        autoStart: "开机自启",
        ball: "DSH 悬浮球",
        panelSize: "页面大小",
        sizeS: "小",
        sizeM: "中",
        sizeL: "大",
        lang: "语言",
        pluginOn: "插件开关",
        askTitle: "要不要开约束？",
        askBody: "T约束 现在关着。这条消息会不受限制地生成。",
        askYes: "确认约束",
        askNo: "直接发送",
        askTip: "也可以再按一次 Enter 直接发送",
        saved: "已保存",
        close: "关闭",
        awaitingToken: "Token 到量，生成已硬断",
        awaitingTime: "时间到点，生成已硬断",
        usedPrefix: "已用 ",
        archiveOffHint: "归档已关闭：到量照样硬断，但不写文件",
        untitled: "（未命名会话）",
        on: "开",
        off: "关",
        dragHint: "拖动可移动面板",
        unitKToken: "千 token",
        unitMin: "分钟",
        kindToken: "token限定版",
        kindTime: "时间限定版",
        kindManual: "手动结束",
      },
      en: {
        title: "T-Lock",
        sub: "Per-turn token & time brakes",
        tabMain: "Limits",
        tabHistory: "Archive",
        tabSettings: "Settings",
        token: "Token cap",
        time: "Time cap",
        thisRound: "This turn",
        noRound: "No turn is being metered",
        custom: "Custom",
        customToken: "Max tokens for this turn",
        customTime: "Max minutes for this turn",
        confirm: "OK",
        cancel: "Cancel",
        archive: "Archive",
        archiveOn: "Archiving on",
        archiveOff: "Archiving off",
        modeBrief: "Brief",
        modeFull: "Full record",
        modeBoth: "Both",
        recommended: "recommended",
        modeHint: {
          brief: "Human-readable summary, including what it left out",
          full: "Nothing dropped: full reasoning, every tool arg and result, raw text",
          both: "Write both files",
        },
        rename: "Rename",
        renameSave: "Save",
        renameCancel: "Cancel",
        renameHint: "New name (timestamp prefix is kept)",
        openInFolder: "Show in folder",
        back: "Back",
        fileEmpty: "(this file is empty)",
        fileBinary: "(binary or too large — open the folder to view)",
        renamed: "Renamed",
        renameFailed: "Rename failed",
        loadFailed: "Couldn't load this archive (older plugin build — restart DSH).",
        running: "Locked",
        paused: "Paused",
        offline: "DSH offline",
        awaiting: "Hard-stopped",
        continueGen: "Continue",
        endRound: "End turn",
        stopNow: "Stop now",
        historyEmpty: "No archives yet.",
        openFolder: "Open folder",
        autoStart: "Start with Windows",
        ball: "Floating ball",
        panelSize: "Panel size",
        sizeS: "S",
        sizeM: "M",
        sizeL: "L",
        lang: "Language",
        pluginOn: "Plugin",
        askTitle: "Turn on T-Lock?",
        askBody: "T-Lock is off. This message will generate without any cap.",
        askYes: "Lock it",
        askNo: "Send anyway",
        askTip: "Or press Enter again to send",
        saved: "Saved",
        close: "Close",
        awaitingToken: "Token cap hit — generation stopped",
        awaitingTime: "Time cap hit — generation stopped",
        usedPrefix: "Used ",
        archiveOffHint: "Archiving is off: still hard-stops at the cap, just writes no files",
        untitled: "(untitled session)",
        on: "On",
        off: "Off",
        dragHint: "Drag to move the panel",
        unitKToken: "K tokens",
        unitMin: "min",
        kindToken: "Token limit",
        kindTime: "Time limit",
        kindManual: "Manual stop",
      },
    };

    // ── 后端接口 ─────────────────────────────────────────────────────
    async function getJson(url, init) {
      const res = await fetch(url, Object.assign({ cache: "no-store" }, init));
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }
    function postSet(patch) {
      return getJson(ROUTE + "/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch }),
      }).catch(() => null);
    }
    function postOpen() {
      return getJson(ROUTE + "/open", { method: "POST" }).catch(() => null);
    }
    function postCmd(action, sid, extra) {
      return getJson(ROUTE + "/cmd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ action, sid }, extra || {})),
      }).catch(() => null);
    }
    function getArchive(path) {
      return getJson(ROUTE + "/archive?path=" + encodeURIComponent(path)).catch(() => null);
    }
    function postRename(path, title, file, name) {
      return getJson(ROUTE + "/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: path, title: title, file: file, name: name }),
      }).catch(() => null);
    }

    // ── 图形：T + 斜向锁链 ───────────────────────────────────────────
    function IconMark(props) {
      const size = props.size || 44;
      const links = [];
      for (let i = 0; i < 5; i++) {
        links.push(
          el("rect", {
            key: "l" + i,
            x: 14 + i * 15,
            y: 14 + i * 15,
            width: 26,
            height: 15,
            rx: 7.5,
            transform: "rotate(45 " + (14 + i * 15 + 13) + " " + (14 + i * 15 + 7.5) + ")",
            fill: "none",
            stroke: "rgba(232,238,246,.92)",
            strokeWidth: 4.2,
          }),
        );
      }
      return el(
        "svg",
        { width: size, height: size, viewBox: "0 0 100 100", "aria-hidden": "true" },
        el("rect", { x: 0, y: 0, width: 100, height: 100, rx: 22, fill: "#0E121A" }),
        el("g", { opacity: 0.95 }, links),
        el(
          "g",
          null,
          el("polygon", {
            points:
              "32,20 68,20 74,26 74,37 59,37 59,80 50,86 41,80 41,37 26,37 26,26",
            fill: "#0E121A",
            stroke: "#0E121A",
            strokeWidth: 7,
            strokeLinejoin: "miter",
          }),
          el("polygon", {
            points: "32,20 68,20 74,26 74,37 59,37 59,80 50,86 41,80 41,37 26,37 26,26",
            fill: "#F2F6FC",
          }),
        ),
      );
    }

    // ── 组件：滑条 ───────────────────────────────────────────────────
    function Slider(props) {
      const { stops, value, onCommit, label, hint, format, accent } = props;
      const trackRef = useRef(null);
      const [drag, setDrag] = useState(false);
      const [live, setLive] = useState(null);
      const pos = valueToPos(stops, value);

      const posFromEvent = useCallback((event) => {
        const node = trackRef.current;
        if (!node) return 0;
        const rect = node.getBoundingClientRect();
        return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      }, []);

      const apply = useCallback(
        (rawPos) => {
          const snap = nearestStopPos(rawPos, stops);
          const finalPos = snap.near ? snap.pos : rawPos;
          const next = posToValue(stops, finalPos);
          setLive({ pos: finalPos, value: next });
          return next;
        },
        [stops],
      );

      const onDown = useCallback(
        (event) => {
          event.preventDefault();
          setDrag(true);
          apply(posFromEvent(event));
        },
        [apply, posFromEvent],
      );

      useEffect(() => {
        if (!drag) return undefined;
        let frame = 0;
        let pending = null;
        const move = (event) => {
          pending = event.clientX;
          if (frame !== 0) return;
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            if (pending !== null) apply(posFromEvent({ clientX: pending }));
          });
        };
        const up = () => {
          setDrag(false);
          setLive((g) => {
            if (g) onCommit(g.value);
            return null;
          });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
      }, [drag, apply, posFromEvent, onCommit]);

      const shown = live !== null ? live.pos : pos;
      const shownText = live !== null && format ? format(live.value) : hint;
      const ticks = stops.map((_, i) => i / (stops.length - 1));

      return el(
        "div",
        { className: "tlk-slider" },
        el(
          "div",
          { className: "tlk-slider-head" },
          el("span", { className: "tlk-slider-label" }, label),
          el("span", { className: "tlk-slider-value" }, shownText),
        ),
        el(
          "div",
          {
            className: "tlk-track" + (drag ? " is-drag" : ""),
            ref: trackRef,
            onPointerDown: onDown,
            style: accent ? { "--tlk-accent": accent } : undefined,
          },
          el("div", { className: "tlk-track-fill", style: { width: shown * 100 + "%" } }),
          ticks.map((t, i) =>
            el("i", {
              key: "tick" + i,
              className: "tlk-tick" + (Math.abs(shown - t) < 0.012 ? " is-hot" : ""),
              style: { left: t * 100 + "%" },
            }),
          ),
          el("div", { className: "tlk-thumb", style: { left: shown * 100 + "%" } }),
        ),
      );
    }

    // ── 组件：分段按钮 ───────────────────────────────────────────────
    function Pills(props) {
      return el(
        "div",
        { className: "tlk-pills" + (props.wide ? " is-wide" : "") },
        props.options.map((option) =>
          el(
            "button",
            {
              key: option.value,
              type: "button",
              className: "tlk-pill" + (String(props.value) === String(option.value) ? " is-on" : ""),
              onClick: () => props.onChange(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    // ── 组件：进度条 ─────────────────────────────────────────────────
    function Meter(props) {
      const pct = Math.max(0, Math.min(100, props.pct || 0));
      return el(
        "div",
        { className: "tlk-meter" + (props.danger ? " is-danger" : "") },
        el("div", { className: "tlk-meter-fill", style: { width: pct + "%" } }),
      );
    }

    // ── 组件：悬浮球 ─────────────────────────────────────────────────
    function Ball(props) {
      const [pos, setPos] = useState(() => {
        try {
          const raw = window.localStorage.getItem(STORAGE_BALL);
          if (raw) return JSON.parse(raw);
        } catch (e) {
          /* ignore */
        }
        return { x: window.innerWidth - 78, y: Math.round(window.innerHeight * 0.62) };
      });
      const dragRef = useRef(null);
      const movedRef = useRef(false);

      const onDown = useCallback(
        (event) => {
          event.preventDefault();
          movedRef.current = false;
          const node = event.currentTarget;
          dragRef.current = {
            dx: event.clientX - pos.x,
            dy: event.clientY - pos.y,
          };
          let last = pos;
          const move = (ev) => {
            if (!dragRef.current) return;
            last = {
              x: Math.max(8, Math.min(window.innerWidth - 60, ev.clientX - dragRef.current.dx)),
              y: Math.max(8, Math.min(window.innerHeight - 60, ev.clientY - dragRef.current.dy)),
            };
            movedRef.current = true;
            if (node) {
              node.style.left = last.x + "px";
              node.style.top = last.y + "px";
            }
          };
          const up = () => {
            dragRef.current = null;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            if (movedRef.current) {
              setPos(last);
              try {
                window.localStorage.setItem(STORAGE_BALL, JSON.stringify(last));
              } catch (e) {
                /* ignore */
              }
            } else {
              props.onOpen();
            }
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        },
        [pos, props],
      );

      return el(
        "button",
        {
          type: "button",
          className: "tlk-ball" + (props.alert ? " is-alert" : ""),
          style: { left: pos.x + "px", top: pos.y + "px" },
          onPointerDown: onDown,
          title: LANG === "en" ? "T-Lock" : "T约束",
        },
        el(IconMark, { size: 34 }),
        props.alert ? el("i", { className: "tlk-ball-dot" }) : null,
      );
    }

    // ── 主面板 ───────────────────────────────────────────────────────
    function Panel(props) {
      const { state, dict, size, onClose, onPatch, onCmd, refresh } = props;
      const [tab, setTab] = useState("main");
      const [pos, setPos] = useState(null);
      const panelRef = useRef(null);
      const [history, setHistory] = useState(null);
      const [customOpen, setCustomOpen] = useState("");
      const [customValue, setCustomValue] = useState("");
      const [toast, setToast] = useState("");
      const [openPath, setOpenPath] = useState("");
      const [detail, setDetail] = useState(null);
      const [fileIndex, setFileIndex] = useState(0);
      const [renaming, setRenaming] = useState(false);
      const [renameValue, setRenameValue] = useState("");

      const settings = (state && state.settings) || {};
      const active = state && state.active;
      const tokenLimit = settings.tokenLimit || 20000;
      const timeLimitSec = settings.timeLimitSec || 300;
      const archiveMode = settings.archiveMode || "brief";
      const archiveEnabled = settings.archiveEnabled !== false;
      const enabled = state ? state.enabled !== false : true;

      const onHeadDown = useCallback(
        (event) => {
          if (event.target && event.target.closest && event.target.closest("button")) return;
          event.preventDefault();
          const start = { x: event.clientX, y: event.clientY };
          const base = pos || { x: 0, y: 0 };
          let last = base;
          const move = (ev) => {
            // 直接改 transform，避免每帧重渲染整棵树（拖动才丝滑）
            last = { x: base.x + ev.clientX - start.x, y: base.y + ev.clientY - start.y };
            if (panelRef.current) panelRef.current.style.transform = "translate(" + last.x + "px," + last.y + "px)";
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            setPos(last);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        },
        [pos],
      );

      const flash = useCallback((text) => {
        setToast(text);
        setTimeout(() => setToast(""), 1400);
      }, []);

      const commitToken = useCallback(
        (value) => {
          onPatch({ tokenLimit: value });
        },
        [onPatch, dict, flash],
      );
      const commitTime = useCallback(
        (value) => {
          onPatch({ timeLimitSec: value });
        },
        [onPatch, dict, flash],
      );

      useEffect(() => {
        if (openPath === "") return;
        let alive = true;
        getArchive(openPath).then((data) => {
          if (!alive) return;
          if (data && data.ok) {
            setDetail(data);
            setFileIndex(0);
          } else {
            setDetail({ ok: false, path: openPath });
          }
        });
        return () => {
          alive = false;
        };
      }, [openPath]);

      useEffect(() => {
        if (tab !== "history") return;
        fetch(ROUTE + "/history")
          .then((r) => r.json())
          .then((data) => setHistory(Array.isArray(data.items) ? data.items : []))
          .catch(() => setHistory([]));
      }, [tab, state && state.at]);

      const openCustom = (which) => {
        setCustomOpen(which);
        setCustomValue(which === "token" ? String(Math.round(tokenLimit / 1000)) : String(Math.round(timeLimitSec / 60)));
      };
      const submitCustom = () => {
        const n = Number(customValue);
        if (!Number.isFinite(n) || n <= 0) {
          setCustomOpen("");
          return;
        }
        if (customOpen === "token") onPatch({ tokenLimit: Math.min(1000000, Math.max(5000, Math.round(n * 1000))) });
        else onPatch({ timeLimitSec: Math.min(7200, Math.max(60, Math.round(n * 60))) });
        setCustomOpen("");
        flash(dict.saved);
      };

      const openDetail = (target) => {
        setOpenPath(target);
        setDetail(null);
        setRenaming(false);
        setFileIndex(0);
      };
      const saveRename = () => {
        const name = String(renameValue || "").trim();
        if (name === "" || openPath === "") {
          setRenaming(false);
          return;
        }
        postRename(openPath, name).then((res) => {
          if (res && res.ok) {
            setRenaming(false);
            setDetail(null);
            setOpenPath(res.path);
            flash(dict.renamed);
          } else {
            flash(dict.renameFailed);
          }
        });
      };

      const usedTokens = active ? active.used : 0;
      const limitTokens = active ? active.limit : tokenLimit;
      const usedMs = active ? active.elapsedMs : 0;
      const limitSec = active ? (active.limitSeconds || timeLimitSec) : timeLimitSec;

      const head = el(
        "div",
        { className: "tlk-head", onPointerDown: onHeadDown, title: dict.dragHint },
        el("div", { className: "tlk-brand" }, el(IconMark, { size: 30 }), el(
          "div",
          null,
          el("div", { className: "tlk-title" }, dict.title),
          el("div", { className: "tlk-sub" }, dict.sub),
        )),
        el(
          "div",
          { className: "tlk-head-right" },
          el(
            "span",
            { className: "tlk-status" + (state ? " is-live" : "") },
            state ? (enabled ? dict.running : dict.paused) : dict.offline,
          ),
          el("button", { type: "button", className: "tlk-icon-btn", onClick: onClose, title: dict.close }, "✕"),
        ),
      );

      const tabs = el(
        "div",
        { className: "tlk-tabs" },
        el(
          "button",
          { type: "button", className: "tlk-tab" + (tab === "main" ? " is-on" : ""), onClick: () => setTab("main") },
          dict.tabMain,
        ),
        el(
          "button",
          { type: "button", className: "tlk-tab" + (tab === "history" ? " is-on" : ""), onClick: () => setTab("history") },
          dict.tabHistory,
        ),
        el(
          "button",
          { type: "button", className: "tlk-tab" + (tab === "settings" ? " is-on" : ""), onClick: () => setTab("settings") },
          dict.tabSettings,
        ),
      );

      let body = null;
      if (tab === "main") {
        const awaiting = active && active.state === "awaiting";
        body = el(
          "div",
          { className: "tlk-body" },
          awaiting
            ? el(
                "div",
                { className: "tlk-awaiting" },
                el("div", { className: "tlk-awaiting-title" }, active.trigger === "time" ? dict.awaitingTime : dict.awaitingToken),
                el("div", { className: "tlk-awaiting-line" }, dict.usedPrefix + fmtTok(active.used) + " / " + fmtTok(active.limit) + (active.trigger === "time" ? " · " + fmtClock(active.elapsedMs) : "")),
                el(
                  "div",
                  { className: "tlk-awaiting-actions" },
                  el("button", { type: "button", className: "tlk-btn is-primary", onClick: () => onCmd("continue", active.sid) }, dict.continueGen),
                  el("button", { type: "button", className: "tlk-btn", onClick: () => onCmd("end", active.sid) }, dict.endRound),
                ),
              )
            : el(
                "div",
                { className: "tlk-card" },
                el(
                  "div",
                  { className: "tlk-row" },
                  el("span", { className: "tlk-row-label" }, dict.thisRound),
                  el(
                    "span",
                    { className: "tlk-row-value" },
                    active ? fmtTok(usedTokens) + " / " + fmtTok(limitTokens) : dict.noRound,
                  ),
                ),
                el(Meter, { pct: active ? (usedTokens / Math.max(1, limitTokens)) * 100 : 0, danger: active ? usedTokens >= limitTokens * 0.9 : false }),
                el(
                  "div",
                  { className: "tlk-row is-sub" },
                  el("span", { className: "tlk-row-label" }, fmtClock(usedMs) + " / " + fmtClock(limitSec * 1000)),
                  el("span", { className: "tlk-row-hint" }, active && active.title ? active.title : ""),
                ),
                el(Meter, { pct: active ? (usedMs / Math.max(1, limitSec * 1000)) * 100 : 0, danger: false }),
              ),
          el(
            "div",
            { className: "tlk-section" },
            el(
              "div",
              { className: "tlk-section-head" },
              el("span", { className: "tlk-section-title" }, dict.token),
              el("button", { type: "button", className: "tlk-link", onClick: () => openCustom("token") }, dict.custom),
            ),
            el(Slider, {
              stops: TOKEN_STOPS,
              value: tokenLimit,
              onCommit: commitToken,
              label: "",
              hint: fmtTok(tokenLimit) + " token",
              format: (v) => fmtTok(v) + " token",
            }),
          ),
          el(
            "div",
            { className: "tlk-section" },
            el(
              "div",
              { className: "tlk-section-head" },
              el("span", { className: "tlk-section-title" }, dict.time),
              el("button", { type: "button", className: "tlk-link", onClick: () => openCustom("time") }, dict.custom),
            ),
            el(Slider, {
              stops: TIME_STOPS,
              value: timeLimitSec,
              onCommit: commitTime,
              label: "",
              hint: fmtTime(timeLimitSec),
              format: (v) => fmtTime(v),
            }),
          ),
          el(
            "div",
            { className: "tlk-section" },
            el(
              "div",
              { className: "tlk-section-head" },
              el("span", { className: "tlk-section-title" }, dict.archive),
              el(
                "button",
                {
                  type: "button",
                  className: "tlk-switch" + (archiveEnabled ? " is-on" : ""),
                  onClick: () => onPatch({ archiveEnabled: !archiveEnabled }),
                },
                el("i", null),
                el("span", null, archiveEnabled ? dict.archiveOn : dict.archiveOff),
              ),
            ),
            el(
              "div",
              { className: "tlk-modes" + (archiveEnabled ? "" : " is-off") },
              [
                ["brief", dict.modeBrief, false],
                ["full", dict.modeFull, true],
                ["both", dict.modeBoth, false],
              ].map(([value, label, rec]) =>
                el(
                  "button",
                  {
                    key: value,
                    type: "button",
                    className: "tlk-mode" + (archiveMode === value ? " is-on" : "") + (rec ? " has-rec" : ""),
                    onClick: () => onPatch({ archiveMode: value }),
                  },
                  el("span", null, label),
                  rec ? el("em", { className: "tlk-rec" }, dict.recommended) : null,
                ),
              ),
            ),
            el("div", { className: "tlk-mode-hint" }, archiveEnabled ? dict.modeHint[archiveMode] : dict.archiveOffHint),
          ),
        );
      } else if (tab === "history") {
        if (openPath !== "") {
          const item = detail;
          const files = item && Array.isArray(item.files) ? item.files : [];
          const current = files[fileIndex] || null;
          const cleanTitle = item ? String(item.name || "").replace(/^\d{8}-\d{6}_/, "") : "";
          body = el(
            "div",
            { className: "tlk-body tlk-detail" },
            el(
              "div",
              { className: "tlk-detail-head" },
              el(
                "button",
                {
                  type: "button",
                  className: "tlk-icon-btn",
                  title: dict.back,
                  onClick: () => {
                    setOpenPath("");
                    setDetail(null);
                    setRenaming(false);
                  },
                },
                "←",
              ),
              renaming
                ? el(
                    "div",
                    { className: "tlk-rename" },
                    el("input", {
                      className: "tlk-input",
                      value: renameValue,
                      placeholder: dict.renameHint,
                      onChange: (e) => setRenameValue(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === "Enter") saveRename();
                        if (e.key === "Escape") setRenaming(false);
                      },
                    }),
                    el("button", { type: "button", className: "tlk-btn is-primary", onClick: saveRename }, dict.renameSave),
                    el("button", { type: "button", className: "tlk-btn", onClick: () => setRenaming(false) }, dict.renameCancel),
                  )
                : el("div", { className: "tlk-detail-title" }, cleanTitle || dict.untitled),
              !renaming && !(item && item.ok === false)
                ? el(
                    "button",
                    {
                      type: "button",
                      className: "tlk-btn",
                      onClick: () => {
                        setRenaming(true);
                        setRenameValue(cleanTitle);
                      },
                    },
                    dict.rename,
                  )
                : null,
            ),
            item === null
              ? el("div", { className: "tlk-empty" }, "…")
              : item.ok === false
                ? el("div", { className: "tlk-empty" }, dict.loadFailed)
              : files.length === 0
                ? el("div", { className: "tlk-empty" }, dict.fileEmpty)
                : el(
                    "div",
                    { className: "tlk-filetabs" },
                    files.map((file, index) =>
                      el(
                        "button",
                        {
                          key: file.name,
                          type: "button",
                          className: "tlk-filetabs-tab" + (index === fileIndex ? " is-on" : ""),
                          onClick: () => setFileIndex(index),
                        },
                        file.name,
                      ),
                    ),
                  ),
            current
              ? el(
                  "pre",
                  { className: "tlk-pre" },
                  current.binary ? dict.fileBinary : current.text === "" || current.text === null ? dict.fileEmpty : current.text,
                )
              : null,
            el(
              "div",
              { className: "tlk-detail-foot" },
              el(
                "button",
                { type: "button", className: "tlk-btn", onClick: () => postCmd("open-path", "", { path: openPath }) },
                dict.openInFolder,
              ),
              el("button", { type: "button", className: "tlk-btn", onClick: () => postOpen() }, dict.openFolder),
            ),
          );
        } else {
          body = el(
            "div",
            { className: "tlk-body tlk-history" },
            history === null
              ? el("div", { className: "tlk-empty" }, "…")
              : history.length === 0
                ? el("div", { className: "tlk-empty" }, dict.historyEmpty)
                : history.map((item) =>
                    el(
                      "button",
                      {
                        key: item.path + item.at,
                        type: "button",
                        className: "tlk-hitem",
                        onClick: () => openDetail(item.path),
                      },
                      el("div", { className: "tlk-hitem-top" }, el("span", { className: "tlk-hitem-title" }, item.title || dict.untitled)),
                      el(
                        "div",
                        { className: "tlk-hitem-meta" },
                        (item.kind === "time" ? dict.kindTime : item.kind === "manual" ? dict.kindManual : dict.kindToken) +
                          " · " +
                          (item.mode === "both" ? dict.modeBoth : item.mode === "full" ? dict.modeFull : dict.modeBrief) +
                          " · " +
                          fmtTok(item.tokens) +
                          " token · " +
                          fmtClock(item.elapsedMs),
                      ),
                    ),
                  ),
            el(
              "div",
              { className: "tlk-history-foot" },
              el("button", { type: "button", className: "tlk-btn", onClick: () => postOpen() }, dict.openFolder),
            ),
          );
        }
      } else {
        body = el(
          "div",
          { className: "tlk-body" },
          el(
            "div",
            { className: "tlk-setrow" },
            el("span", null, dict.pluginOn),
            el(
              "button",
              { type: "button", className: "tlk-switch" + (enabled ? " is-on" : ""), onClick: () => onPatch({ enabled: !enabled }) },
              el("i", null),
              el("span", null, enabled ? dict.on : dict.off),
            ),
          ),
          el(
            "div",
            { className: "tlk-setrow" },
            el("span", null, dict.ball),
            el(
              "button",
              { type: "button", className: "tlk-switch" + (settings.ball !== false ? " is-on" : ""), onClick: () => onPatch({ ball: settings.ball === false }) },
              el("i", null),
              el("span", null, settings.ball === false ? dict.off : dict.on),
            ),
          ),
          el(
            "div",
            { className: "tlk-setrow" },
            el("span", null, dict.autoStart),
            el(
              "button",
              { type: "button", className: "tlk-switch" + (settings.autoStart ? " is-on" : ""), onClick: () => onPatch({ autoStart: !settings.autoStart }) },
              el("i", null),
              el("span", null, settings.autoStart ? dict.on : dict.off),
            ),
          ),
          el(
            "div",
            { className: "tlk-setrow" },
            el("span", null, dict.panelSize),
            el(Pills, {
              value: settings.panelSize || "m",
              onChange: (value) => onPatch({ panelSize: value }),
              options: [
                { value: "s", label: dict.sizeS },
                { value: "m", label: dict.sizeM },
                { value: "l", label: dict.sizeL },
              ],
            }),
          ),
          el(
            "div",
            { className: "tlk-setrow" },
            el("span", null, dict.lang),
            el(Pills, {
              value: settings.lang || "zh",
              onChange: (value) => onPatch({ lang: value }),
              options: [
                { value: "zh", label: "中文" },
                { value: "en", label: "EN" },
              ],
            }),
          ),
          el(
            "button",
            { type: "button", className: "tlk-btn is-block", onClick: () => onCmd("open") },
            dict.openFolder,
          ),
          el("div", { className: "tlk-foot" }, "dsh-tlock " + (state && state.version ? state.version : "0.1.0")),
        );
      }

      const customDialog = customOpen
        ? el(
            "div",
            { className: "tlk-dim" },
            el(
              "div",
              { className: "tlk-dialog" },
              el("div", { className: "tlk-dialog-title" }, customOpen === "token" ? dict.customToken : dict.customTime),
              el(
                "div",
                { className: "tlk-dialog-input" },
                el("input", {
                  type: "number",
                  value: customValue,
                  autoFocus: true,
                  onChange: (event) => setCustomValue(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") submitCustom();
                    if (event.key === "Escape") setCustomOpen("");
                  },
                }),
                el("span", null, customOpen === "token" ? dict.unitKToken : dict.unitMin),
              ),
              el(
                "div",
                { className: "tlk-dialog-actions" },
                el("button", { type: "button", className: "tlk-btn", onClick: () => setCustomOpen("") }, dict.cancel),
                el("button", { type: "button", className: "tlk-btn is-primary", onClick: submitCustom }, dict.confirm),
              ),
            ),
          )
        : null;

      const panel = el(
        "div",
        {
          className: "tlk-panel is-" + (size || "m"),
          ref: panelRef,
          style: pos ? { transform: "translate(" + pos.x + "px," + pos.y + "px)" } : undefined,
          onPointerDown: (event) => event.stopPropagation(),
        },
        el("div", { className: "tlk-inner" }, head, tabs, body),
        toast ? el("div", { className: "tlk-toast" }, toast) : null,
        customDialog,
      );

      return el(
        "div",
        { className: "tlk-overlay", onPointerDown: onClose },
        panel,
      );
    }

    // ── 入口组件 ─────────────────────────────────────────────────────
    function TLockRoot() {
      const [state, setState] = useState(null);
      const [open, setOpen] = useState(false);
      const [ask, setAsk] = useState(false);
      const dict = useMemo(() => DICT.zh, []);
      const settingsRef = useRef({});

      const refresh = useCallback(() => {
        getJson(ROUTE + "/state")
          .then((data) => {
            settingsRef.current = Object.assign({}, data.settings || {}, {
              enabled: data.enabled !== false,
            });
            setState(data);
          })
          .catch(() => setState(null));
      }, []);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, POLL_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      const dictLocal = useMemo(() => {
        const lang = (state && state.settings && state.settings.lang) || "zh";
        LANG = lang === "en" ? "en" : "zh";
        return DICT[lang] || DICT.zh;
      }, [state]);

      const onPatch = useCallback(
        (patch) => {
          postSet(patch).then(() => refresh());
        },
        [refresh],
      );
      const onCmd = useCallback(
        (action, sid) => {
          if (action === "open") {
            postOpen().then(() => refresh());
            return;
          }
          postCmd(action, sid).then(() => refresh());
        },
        [refresh],
      );

      // 关闭插件：把球和面板一起收掉
      const pluginEnabled = state ? state.enabled !== false : true;
      const ballOn = (state && state.settings ? state.settings.ball !== false : true) && pluginEnabled;

      // 输入拦截：约束关着时，先问一句要不要开
      useEffect(() => {
        let armed = false;
        const onKey = (event) => {
          if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
          const target = event.target;
          if (!target || !target.closest) return;
          if (!target.closest("[data-composer-input]") && !target.closest("[data-composer-card]")) return;
          const enabled = settingsRef.current && settingsRef.current.enabled !== false;
          if (enabled) return;
          if (armed) {
            armed = false;
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          armed = true;
          setAsk(true);
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      }, []);

      const confirmLock = useCallback(() => {
        postSet({ enabled: true }).then(() => {
          setAsk(false);
          setOpen(true);
          refresh();
        });
      }, [refresh]);

      return el(
        "div",
        { className: "tlk-root" },
        ballOn
          ? el(Ball, {
              alert: !!(state && state.active && state.active.state === "awaiting"),
              onOpen: () => {
                setOpen(true);
                refresh();
              },
            })
          : null,
        open && state
          ? el(Panel, {
              state,
              dict: dictLocal,
              size: (state.settings && state.settings.panelSize) || "m",
              onClose: () => setOpen(false),
              onPatch,
              onCmd,
              refresh,
            })
          : null,
        ask
          ? el(
              "div",
              { className: "tlk-ask-wrap" },
              el(
                "div",
                { className: "tlk-ask" },
                el("div", { className: "tlk-ask-title" }, dictLocal.askTitle),
                el("div", { className: "tlk-ask-body" }, dictLocal.askBody),
                el(
                  "div",
                  { className: "tlk-ask-actions" },
                  el("button", { type: "button", className: "tlk-btn is-primary", onClick: confirmLock }, dictLocal.askYes),
                  el("button", { type: "button", className: "tlk-btn", onClick: () => setAsk(false) }, dictLocal.askNo),
                ),
                el("div", { className: "tlk-ask-tip" }, dictLocal.askTip),
              ),
            )
          : null,
      );
    }

    const CSS = `
.tlk-root{position:fixed;inset:0;pointer-events:none;z-index:2147482000;font-family:"Microsoft YaHei UI","PingFang SC",system-ui,sans-serif}
.tlk-root>*{pointer-events:auto}
.tlk-ball{position:fixed;width:46px;height:46px;padding:6px;border:0;border-radius:13px;background:#0E121A;
  box-shadow:0 10px 26px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.08);cursor:grab;display:grid;place-items:center;
  transition:transform .16s ease,box-shadow .16s ease;touch-action:none}
.tlk-ball:hover{transform:translateY(-1px) scale(1.04);box-shadow:0 14px 32px rgba(0,0,0,.48),0 0 0 1px rgba(255,255,255,.16)}
.tlk-ball:active{cursor:grabbing;transform:scale(.97)}
.tlk-ball svg{border-radius:9px;display:block}
.tlk-ball-dot{position:absolute;right:-2px;top:-2px;width:10px;height:10px;border-radius:50%;background:#F59E0B;box-shadow:0 0 0 2px #0E121A}
.tlk-ball.is-alert{box-shadow:0 0 0 2px #F59E0B,0 10px 26px rgba(0,0,0,.4)}
.tlk-overlay{position:fixed;inset:0;display:grid;place-items:center;background:transparent;z-index:2147482500}
.tlk-panel{position:relative;width:436px;max-height:78vh;display:flex;flex-direction:column;border-radius:18px;overflow:hidden;
  background:linear-gradient(180deg,#171C26 0%,#12161F 100%);color:#E8ECF3;
  box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.07);animation:tlk-rise .28s cubic-bezier(.2,.8,.2,1)}
.tlk-panel.is-s{width:380px}.tlk-panel.is-l{width:500px}
@keyframes tlk-rise{from{transform:translateY(10px);opacity:0}to{transform:none;opacity:1}}
.tlk-inner{display:flex;flex-direction:column;min-height:0;max-height:78vh}
.tlk-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px;cursor:grab;user-select:none}
.tlk-head:active{cursor:grabbing}
.tlk-brand{display:flex;align-items:center;gap:10px}
.tlk-brand svg{border-radius:9px}
.tlk-title{font-size:15px;font-weight:600;letter-spacing:.4px}
.tlk-sub{font-size:11px;color:#8B93A3;margin-top:2px}
.tlk-head-right{display:flex;align-items:center;gap:8px}
.tlk-status{font-size:11px;color:#7D8595;padding:4px 8px;border-radius:999px;background:rgba(255,255,255,.05)}
.tlk-status.is-live{color:#4ADE80;background:rgba(74,222,128,.1)}
.tlk-icon-btn{width:26px;height:26px;border:0;border-radius:8px;background:transparent;color:#9AA3B2;cursor:pointer;font-size:13px}
.tlk-icon-btn:hover{background:rgba(255,255,255,.08);color:#E8ECF3}
.tlk-tabs{display:flex;gap:6px;padding:4px 18px 10px;border-bottom:1px solid rgba(255,255,255,.06)}
.tlk-tab{border:0;background:transparent;color:#8B93A3;font-size:12px;padding:6px 10px;border-radius:8px;cursor:pointer}
.tlk-tab:hover{color:#E8ECF3;background:rgba(255,255,255,.05)}
.tlk-tab.is-on{color:#0E121A;background:#E8EEF6;font-weight:600}
.tlk-body{padding:14px 18px 16px;overflow:auto;min-height:0}
.tlk-card{border-radius:12px;background:rgba(255,255,255,.035);padding:12px 13px;margin-bottom:14px}
.tlk-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:8px}
.tlk-row-label{color:#8B93A3}
.tlk-row-value{color:#E8ECF3;font-variant-numeric:tabular-nums;font-weight:600}
.tlk-row.is-sub{margin:8px 0 6px;font-size:11px}
.tlk-row-hint{color:#6E7686;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tlk-meter{height:6px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden;margin-bottom:2px}
.tlk-meter-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#22C55E,#4ADE80);transition:width .3s ease}
.tlk-meter.is-danger .tlk-meter-fill{background:linear-gradient(90deg,#F59E0B,#EF4444)}
.tlk-awaiting{border-radius:12px;padding:14px;margin-bottom:14px;background:rgba(239,68,68,.1);box-shadow:inset 0 0 0 1px rgba(239,68,68,.25)}
.tlk-awaiting-title{font-size:13px;font-weight:600;color:#FCA5A5}
.tlk-awaiting-line{font-size:11px;color:#B9A2A2;margin-top:5px;font-variant-numeric:tabular-nums}
.tlk-awaiting-actions{display:flex;gap:8px;margin-top:12px}
.tlk-section{margin-bottom:16px}
.tlk-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
.tlk-section-title{font-size:12px;color:#C7CEDA;letter-spacing:.3px}
.tlk-link{border:0;background:transparent;color:#7C86F8;font-size:11px;cursor:pointer;padding:2px 4px;border-radius:6px}
.tlk-link:hover{background:rgba(124,134,248,.12)}
.tlk-slider-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.tlk-slider-label{font-size:11px;color:#7D8595}
.tlk-slider-value{font-size:12px;color:#E8ECF3;font-variant-numeric:tabular-nums}
.tlk-track{position:relative;height:22px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.tlk-track::before{content:"";position:absolute;left:0;right:0;height:5px;border-radius:999px;background:#0B0E14;box-shadow:inset 0 0 0 1px rgba(255,255,255,.09)}
.tlk-track-fill{position:absolute;height:5px;border-radius:999px;background:linear-gradient(90deg,#C9D2E0,#8FA0B8)}
.tlk-tick{position:absolute;width:1.5px;height:9px;border-radius:1px;background:rgba(255,255,255,.22);transform:translateX(-50%);top:50%;margin-top:-4.5px}
.tlk-tick.is-hot{background:#FFF;height:12px;margin-top:-6px}
.tlk-thumb{position:absolute;width:14px;height:14px;border-radius:50%;background:#F2F6FC;box-shadow:0 2px 8px rgba(0,0,0,.45);transform:translate(-50%,0);top:50%;margin-top:-7px;transition:transform .12s ease}
.tlk-track.is-drag .tlk-thumb{transform:translate(-50%,0) scale(1.15);transition:none}
.tlk-track .tlk-thumb{will-change:left;transition:none}
.tlk-track .tlk-track-fill{will-change:width;transition:none}
.tlk-modes{display:flex;gap:7px}
.tlk-modes.is-off{opacity:.45}
.tlk-mode{flex:1;border:0;border-radius:9px;padding:9px 6px;font-size:11px;cursor:pointer;background:rgba(255,255,255,.05);color:#9AA3B2}
.tlk-mode:hover{background:rgba(255,255,255,.09);color:#E8ECF3}
.tlk-mode.is-on{background:#E8EEF6;color:#0E121A;font-weight:600}
.tlk-mode-hint{font-size:10.5px;color:#6E7686;margin-top:7px;line-height:1.5}
.tlk-switch{display:inline-flex;align-items:center;gap:7px;border:0;background:rgba(255,255,255,.06);color:#9AA3B2;font-size:11px;
  padding:5px 9px;border-radius:999px;cursor:pointer}
.tlk-switch i{width:26px;height:14px;border-radius:999px;background:rgba(255,255,255,.16);position:relative;display:inline-block;transition:background .16s}
.tlk-switch i::after{content:"";position:absolute;left:2px;top:2px;width:10px;height:10px;border-radius:50%;background:#8B93A3;transition:transform .16s,background .16s}
.tlk-switch.is-on{color:#4ADE80;background:rgba(74,222,128,.12)}
.tlk-switch.is-on i{background:rgba(74,222,128,.35)}
.tlk-switch.is-on i::after{transform:translateX(12px);background:#4ADE80}
.tlk-btn{border:0;border-radius:9px;padding:8px 13px;font-size:12px;cursor:pointer;background:rgba(255,255,255,.08);color:#DCE2EC}
.tlk-btn:hover{background:rgba(255,255,255,.14)}
.tlk-btn.is-primary{background:#E8EEF6;color:#0E121A;font-weight:600}
.tlk-btn.is-primary:hover{background:#FFF}
.tlk-btn.is-block{width:100%;margin-top:6px}
.tlk-setrow{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:12px;color:#C7CEDA}
.tlk-pills{display:inline-flex;gap:6px}
.tlk-pill{border:0;border-radius:8px;padding:5px 10px;font-size:11px;background:rgba(255,255,255,.06);color:#9AA3B2;cursor:pointer}
.tlk-pill.is-on{background:#E8EEF6;color:#0E121A;font-weight:600}
.tlk-empty{color:#6E7686;font-size:12px;text-align:center;padding:36px 10px;line-height:1.7}
.tlk-history{padding-top:10px}
.tlk-hitem{width:100%;text-align:left;border:0;font:inherit;cursor:pointer;padding:10px 12px;border-radius:10px;
  background:rgba(255,255,255,.035);margin-bottom:8px;transition:background .12s}
.tlk-hitem:hover{background:rgba(255,255,255,.075)}
.tlk-mode.has-rec{position:relative;display:inline-flex;align-items:center;gap:5px}
.tlk-rec{font-style:normal;font-size:9px;line-height:1;padding:2px 4px;border-radius:4px;
  background:rgba(74,222,128,.16);color:#86EFAC}
.tlk-mode.is-on .tlk-rec{background:rgba(14,18,26,.16);color:#0E121A}
.tlk-detail{display:flex;flex-direction:column;min-height:0}
.tlk-detail-head{display:flex;align-items:center;gap:8px;padding:2px 2px 10px}
.tlk-detail-title{flex:1;font-size:12.5px;color:#E8ECF3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tlk-rename{flex:1;display:flex;align-items:center;gap:6px}
.tlk-input{flex:1;min-width:0;border:0;outline:0;border-radius:8px;padding:6px 9px;font-size:12px;
  background:rgba(255,255,255,.07);color:#E8ECF3}
.tlk-filetabs{display:flex;gap:6px;flex-wrap:wrap;padding:0 2px 8px}
.tlk-filetabs-tab{border:0;border-radius:7px;padding:4px 9px;font-size:10.5px;cursor:pointer;
  background:rgba(255,255,255,.05);color:#9AA3B2}
.tlk-filetabs-tab.is-on{background:#E8EEF6;color:#0E121A;font-weight:600}
.tlk-pre{flex:1;min-height:0;overflow:auto;margin:0 0 10px;padding:12px;border-radius:10px;
  background:rgba(0,0,0,.28);color:#D5DBE6;font-size:11px;line-height:1.65;white-space:pre-wrap;
  word-break:break-word;font-family:"Cascadia Mono","Consolas",monospace;max-height:340px}
.tlk-detail-foot{display:flex;gap:8px;padding:0 2px 6px}
.tlk-hitem-title{font-size:12px;color:#E8ECF3}
.tlk-hitem-meta{font-size:10.5px;color:#7D8595;margin-top:4px;font-variant-numeric:tabular-nums}
.tlk-history-foot{padding:0 18px 14px}
.tlk-foot{font-size:10px;color:#5C6472;text-align:center;margin-top:12px}
.tlk-toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);background:rgba(74,222,128,.16);color:#86EFAC;
  font-size:11px;padding:6px 12px;border-radius:999px;animation:tlk-rise .2s}
.tlk-dim{position:absolute;inset:0;background:rgba(6,8,12,.5);display:grid;place-items:center}
.tlk-dialog{width:280px;border-radius:14px;background:#1A1F2A;padding:16px;box-shadow:0 20px 60px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08)}
.tlk-dialog-title{font-size:12px;color:#C7CEDA;margin-bottom:10px}
.tlk-dialog-input{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.06);border-radius:9px;padding:8px 10px}
.tlk-dialog-input input{flex:1;border:0;outline:0;background:transparent;color:#E8ECF3;font-size:13px;font-variant-numeric:tabular-nums}
.tlk-dialog-input span{font-size:11px;color:#7D8595}
.tlk-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.tlk-ask-wrap{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:2147483000}
.tlk-ask{width:340px;border-radius:14px;padding:16px;background:#171C26;color:#E8ECF3;
  box-shadow:0 24px 60px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08);animation:tlk-rise .22s}
.tlk-ask-title{font-size:13px;font-weight:600}
.tlk-ask-body{font-size:11.5px;color:#8B93A3;margin-top:6px;line-height:1.6}
.tlk-ask-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.tlk-ask-tip{font-size:10.5px;color:#5C6472;margin-top:9px}
to{opacity:1;transform:none}}
`;

    const inject = ["slots"];

    function apply(ctx) {
      try {
        ctx.effect(() => {
          const tag = document.createElement("style");
          tag.id = "dsh-tlock-style";
          tag.dataset.plugin = "dsh-tlock";
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => {
            try {
              tag.remove();
            } catch (e) {
              /* ignore */
            }
          };
        }, "dsh-tlock: styles");
        ctx.slots.inject("shell.overlay", () => {
          const dispose = ctx.slots.register({ name: "shell.overlay", id: "tlock-ball", order: 940 }, TLockRoot);
          return () => dispose();
        });
      } catch (error) {
        try {
          console.error("[dsh-tlock] client apply failed", error);
        } catch (e) {
          /* ignore */
        }
      }
    }

    return { inject, apply };
  },
});

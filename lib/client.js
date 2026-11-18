// Browser half for dsh-no-project-sessions.
//
// A normal client package bundle in the same lazy-CJS format as the shipped
// ui-* packages, and strictly additive: it does not replace the shipped
// workspace browser or conversation package. It does three things.
//
//   1. Wraps `conversation.sendSession` so a no-project session asks the Host
//      for its dated, numbered working directory before the prompt is sent.
//   2. Replaces the blank-session workspace picker with one that adds a
//      "work without a project" entry selecting the "最近" workspace.
//   3. Contributes the bundle's own settings page, where the draft root is
//      chosen once.
//
// The "最近" workspace stays the session's own Workspace; only the effective
// working directory moves into the dated folder. That is what keeps every
// no-project session listed inside the one section, in order.
//
// Nothing here imports a host Client package: the menu is drawn with host theme
// tokens because a host primitive's props change between releases and a throwing
// entry blanks this plugin's slot.
window.__ModuleLoader__.load({
  id: "dsh-no-project-sessions",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const ReactDOM = require("react-dom");
    const NS = "noProjectSessions";
    const PREPARE_PATH = "/dsh-no-project/prepare";
    const CONFIG_PATH = "/dsh-no-project/config";
    const PATCH = Symbol.for("dsh-no-project-sessions.sendSession");
    const HANDLER = Symbol.for("dsh-no-project-sessions.sendSessionHandler");
    const NEW_PROJECT_ITEM = "::new-project";
    const NO_PROJECT_ITEM = "::no-project";

    const zh = {
      "noProject": "不在项目中工作",
      "workspace.defaultName": "工作区",
      "chooseProject": "选择项目",
      "newProject": "新建项目",
      "prepareFailed": "创建目录失败",
      "settings.title": "默认对话目录",
      "settings.description": "无项目会话的目录建在这里，按日期和序号分子目录。修改后插件会重启，此后新建的会话使用新目录。",
      "settings.placeholder": "例如 C:\\Notes 或 ~/Notes",
      "settings.browse": "浏览…",
      "settings.save": "保存",
      "settings.saving": "保存中…",
      "settings.saved": "已保存，插件正在重启。",
      "settings.effective": "当前生效目录",
      "settings.loadFailed": "读取当前目录失败，暂时无法保存。",
      "settings.saveFailed": "保存失败。",
      "settings.browseFailed": "打开目录选择器失败。",
      "settings.invalid": "请输入绝对路径。",
    };
    const en = {
      "noProject": "Work without a project",
      "workspace.defaultName": "Workspace",
      "chooseProject": "Choose project",
      "newProject": "New project",
      "prepareFailed": "Could not create the directory",
      "settings.title": "Default conversation directory",
      "settings.description": "No-project sessions create a dated, numbered folder here. Saving restarts the plugin; sessions created afterwards use the new directory.",
      "settings.placeholder": "For example C:\\Notes or ~/Notes",
      "settings.browse": "Browse…",
      "settings.save": "Save",
      "settings.saving": "Saving…",
      "settings.saved": "Saved. The plugin is restarting.",
      "settings.effective": "Directory in effect",
      "settings.loadFailed": "Could not read the current directory, so saving is unavailable.",
      "settings.saveFailed": "Could not save.",
      "settings.browseFailed": "Could not open the directory picker.",
      "settings.invalid": "Enter an absolute path.",
    };

    const normalize = (value) =>
      String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

    let currentContext;

    // ---- draft root -------------------------------------------------------
    //
    // Read from the Host and re-read when the page regains focus: the setting
    // lives in the profile, and changing it restarts the Host row without
    // reloading this page. A stale root would classify the wrong sessions as
    // no-project, so it is never guessed.
    let scratchRoot = "";
    let scratchWorkspaceId = "";
    let scratchRootLoaded = false;
    let scratchRootRequest;
    const scratchRootListeners = new Set();

    function subscribeScratchRoot(listener) {
      scratchRootListeners.add(listener);
      return () => { scratchRootListeners.delete(listener); };
    }

    function setScratchRoot(root, workspaceId) {
      const nextRoot = typeof root === "string" ? root : "";
      const nextId = typeof workspaceId === "string" ? workspaceId : "";
      if (nextRoot === scratchRoot && nextId === scratchWorkspaceId) return;
      scratchRoot = nextRoot;
      scratchWorkspaceId = nextId;
      scratchRootLoaded = nextRoot !== "";
      for (const listener of [...scratchRootListeners]) {
        try { listener(); } catch (error) { console.warn("no-project-sessions: root listener failed:", error); }
      }
    }

    function loadScratchRoot(force = false) {
      if (!force && scratchRootLoaded) return Promise.resolve(scratchRoot);
      if (scratchRootRequest === undefined) {
        scratchRootRequest = fetch(CONFIG_PATH, { method: "GET" })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((payload) => {
            setScratchRoot(payload?.root, payload?.workspaceId);
            return scratchRoot;
          })
          .catch(() => {
            scratchRootLoaded = scratchRoot !== "";
            return scratchRoot;
          })
          .finally(() => { scratchRootRequest = undefined; });
      }
      return scratchRootRequest;
    }

    function scratchBase() {
      return scratchRoot === "" ? "" : normalize(scratchRoot);
    }

    /** Whether a session's own Workspace is the "最近" section. */
    function isNoProjectCwd(cwd) {
      if (typeof cwd !== "string" || cwd === "") return false;
      const base = scratchBase();
      return base !== "" && normalize(cwd) === base;
    }

    // ---- section heading --------------------------------------------------
    //
    // This Host has no public Slot for a Workspace group header, so the "最近"
    // row is restyled in place: it should read as a sibling section heading next
    // to "工作区", not as another project row with a folder icon.
    //
    // The selector keys on the Workspace id the browser already publishes on its
    // row, so it can never touch a real project. The two hidden spans are the
    // folder glyph and the expand chevron; the third carries the title. That
    // ordering is host markup, not a contract — if a future Host reorders those
    // spans this rule either stops matching or hides the wrong thing, which is
    // why it is isolated here and re-checked in docs/verification.md.
    function installRecentGroupStyle() {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-no-project-sessions";
      const render = () => {
        const workspaceId = scratchWorkspaceId;
        if (workspaceId === "") {
          style.textContent = "";
          return;
        }
        const attribute = String(workspaceId).replace(/["\\]/g, "\\$&");
        const row = `[data-row-key="workspace:${attribute}"]`;
        style.textContent = `
          ${row} {
            height: 36px !important;
            padding: 0 4px !important;
            padding-inline-start: calc(4px + var(--dsh-workspace-indent, 0px)) !important;
            margin: 8px -4px 4px 0 !important;
            gap: 4px !important;
            color: var(--dsw-alias-label-secondary) !important;
            background: transparent !important;
          }
          ${row}:hover {
            background: transparent !important;
          }
          ${row} > span:nth-child(1),
          ${row} > span:nth-child(2) {
            display: none !important;
          }
        `;
      };
      document.head.appendChild(style);
      const off = subscribeScratchRoot(render);
      render();
      return () => {
        off();
        style.remove();
      };
    }

    // ---- own styles -------------------------------------------------------

    function installOwnStyle() {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-no-project-sessions";
      style.textContent = `
        .npsMenu {
          padding: 4px;
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: 8px;
          background: var(--dsw-alias-bg-overlay);
          box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
          overflow-y: auto;
          max-height: min(60vh, 420px);
        }
        .npsMenuRow {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          height: 32px;
          padding: 0 8px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--dsw-alias-label-primary);
          font: inherit;
          font-size: 13px;
          text-align: start;
          cursor: pointer;
        }
        .npsMenuRow:hover:not(:disabled),
        .npsMenuRow:focus-visible {
          background: var(--dsw-alias-bg-layer-2);
          outline: none;
        }
        .npsMenuRow[data-selected="1"] {
          background: var(--dsw-alias-bg-layer-2);
        }
        .npsMenuRow:disabled {
          color: var(--dsw-alias-state-error-primary);
          cursor: default;
        }
        .npsMenuLabel {
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
        .npsSettings {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .npsSettingsTitle {
          color: var(--dsw-alias-label-primary);
          font-size: 13px;
          font-weight: 500;
        }
        .npsSettingsDesc {
          color: var(--dsw-alias-label-secondary);
          font-size: 12px;
          line-height: 1.5;
        }
        .npsSettingsCurrent {
          color: var(--dsw-alias-label-secondary);
          font-size: 12px;
        }
        .npsSettingsCurrent code {
          color: var(--dsw-alias-label-primary);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          word-break: break-all;
        }
        .npsSettingsRow {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .npsSettingsInput {
          flex: 1;
          min-width: 0;
          height: 32px;
          padding: 0 8px;
          border: 0.5px solid var(--dsw-alias-border-l2);
          border-radius: 6px;
          background: var(--dsw-alias-bg-base);
          color: var(--dsw-alias-label-primary);
          font: inherit;
          font-size: 13px;
        }
        .npsSettingsInput:focus-visible {
          outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
          outline-offset: 1px;
        }
        .npsSettingsButton {
          height: 32px;
          padding: 0 12px;
          border: 0.5px solid var(--dsw-alias-border-l2);
          border-radius: 6px;
          background: transparent;
          color: var(--dsw-alias-label-primary);
          font: inherit;
          font-size: 13px;
          cursor: pointer;
          white-space: nowrap;
        }
        .npsSettingsButton:hover:not(:disabled) {
          background: var(--dsw-alias-bg-layer-2);
        }
        .npsSettingsButton:focus-visible {
          outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
          outline-offset: 1px;
        }
        .npsSettingsButton:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .npsSettingsButton[data-primary] {
          border-color: transparent;
          background: var(--dsw-alias-button-primary-fill);
          color: var(--dsw-alias-label-primary-foreground);
        }
        .npsSettingsButton[data-primary]:hover:not(:disabled) {
          background: var(--dsw-alias-button-primary-hover);
        }
        .npsSettingsStatus {
          font-size: 12px;
          line-height: 1.5;
        }
        .npsSettingsStatus[data-tone="ok"] {
          color: var(--dsw-alias-state-success-primary);
        }
        .npsSettingsStatus[data-tone="error"] {
          color: var(--dsw-alias-state-error-primary);
        }
      `;
      document.head.appendChild(style);
      return () => style.remove();
    }

    // ---- glyphs -----------------------------------------------------------

    function FolderGlyph() {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
          width: 16,
          height: 16,
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinejoin: "round",
        },
        React.createElement("path", {
          d: "M2.2 4.6c0-.6.5-1.1 1.1-1.1h2.5l1.4 1.5h4.6c.6 0 1.1.5 1.1 1.1v5.6c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1V4.6Z",
        }),
      );
    }

    function CrossGlyph() {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
          width: 16,
          height: 16,
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
        },
        React.createElement("path", { d: "m4 4 8 8M12 4l-8 8" }),
      );
    }

    function PlusGlyph() {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
          width: 16,
          height: 16,
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
        },
        React.createElement("path", { d: "M8 3.5v9M3.5 8h9" }),
      );
    }

    // ---- menu -------------------------------------------------------------

    /**
     * Self-contained dropdown. Client plugins must not import host Client
     * packages, so this renders its own popover: portal to the document body,
     * positioned against the trigger, with Escape dismissal, and the host theme
     * tokens.
     */
    function Menu({ open, items, footer, selectedId, onSelect, onClose, anchorRef, t }) {
      const surfaceRef = React.useRef(null);
      const [placement, setPlacement] = React.useState(null);
      const rows = React.useMemo(() => [...items, ...(footer ?? [])], [items, footer]);

      React.useEffect(() => {
        if (!open) {
          setPlacement(null);
          return undefined;
        }
        const measure = () => {
          const anchor = anchorRef?.current;
          if (anchor === null || anchor === undefined) return;
          const rect = anchor.getBoundingClientRect();
          const surface = surfaceRef.current;
          const height = surface === null ? 0 : surface.offsetHeight;
          const below = window.innerHeight - rect.bottom - 8;
          const above = rect.top - 8;
          const flip = below < Math.min(height, 320) && above > below;
          setPlacement({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 8)),
            ...(flip
              ? { bottom: window.innerHeight - rect.top + 4 }
              : { top: rect.bottom + 4 }),
          });
        };
        measure();
        const frame = requestAnimationFrame(measure);
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return () => {
          cancelAnimationFrame(frame);
          window.removeEventListener("resize", measure);
          window.removeEventListener("scroll", measure, true);
        };
      }, [open, anchorRef]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
      }, [open, onClose]);

      if (!open || rows.length === 0) return null;

      const style = {
        position: "fixed",
        zIndex: 2147483000,
        minWidth: 200,
        maxWidth: 320,
        ...(placement ?? { top: -9999, left: -9999 }),
      };
      const row = (item) => {
        const selected = item.id === selectedId;
        return React.createElement(
          "button",
          {
            key: item.id,
            type: "button",
            role: "menuitem",
            "aria-current": selected ? "true" : undefined,
            className: "npsMenuRow",
            "data-selected": selected ? "1" : undefined,
            disabled: item.disabled === true,
            onClick: () => { if (item.disabled !== true) onSelect(item.id); },
          },
          item.icon ?? null,
          React.createElement("span", { className: "npsMenuLabel" }, item.label),
        );
      };
      return ReactDOM.createPortal(
        React.createElement(
          "div",
          {
            ref: surfaceRef,
            className: "npsMenu",
            role: "menu",
            "aria-label": t("chooseProject"),
            style,
            onPointerDown: (event) => event.stopPropagation(),
          },
          rows.map(row),
        ),
        document.body,
      );
    }

    /**
     * Replaces the host workspace picker (shadows it at priority -1) so it gains
     * "new project" and "work without a project" entries. The "最近" workspace
     * is offered only through the latter, so it never looks like a project.
     */
    function WorkspaceMenu({ open, selectedId, onPick, onClose, anchorRef, useWorkspaces, t }) {
      const workspaces = useWorkspaces((state) => state.items) ?? [];
      const [, bumpRoot] = React.useState(0);
      React.useEffect(() => subscribeScratchRoot(() => bumpRoot(n => n + 1)), []);

      // Keep the chip's own toggle working: the host Menu closes on any document
      // pointerdown outside its root, and the chip button is outside it. While
      // the menu is open, swallow the chip's pointerdown so that handler does not
      // fire before the chip's click toggles it shut.
      React.useEffect(() => {
        const element = anchorRef?.current;
        if (!open || element === null || element === undefined) return undefined;
        const swallow = (event) => event.stopPropagation();
        element.addEventListener("pointerdown", swallow, true);
        return () => element.removeEventListener("pointerdown", swallow, true);
      }, [open, anchorRef]);

      const scratchId = workspaces.find(
        (workspace) => scratchWorkspaceId !== "" && workspace.workspaceId === scratchWorkspaceId,
      )?.workspaceId ?? (scratchBase() === ""
        ? undefined
        : workspaces.find((workspace) => normalize(workspace.path) === scratchBase())?.workspaceId);

      const items = workspaces
        .filter((workspace) => workspace.workspaceId !== scratchId)
        .map((workspace) => ({
          id: workspace.workspaceId,
          label: workspace.title || t("workspace.defaultName"),
          icon: React.createElement(FolderGlyph, null),
        }));
      const footer = [
        {
          id: NEW_PROJECT_ITEM,
          label: t("newProject"),
          icon: React.createElement(PlusGlyph, null),
        },
      ];
      if (scratchId !== undefined) {
        footer.push({
          id: NO_PROJECT_ITEM,
          label: t("noProject"),
          icon: React.createElement(CrossGlyph, null),
        });
      }

      const handleSelect = async (id) => {
        if (id === NEW_PROJECT_ITEM) {
          // Close the dropdown before the native directory dialog appears.
          onClose();
          try {
            const path = await currentContext.uiWorkspace.pickDirectory();
            if (path === null || path === undefined || path === "") return;
            const workspace = await currentContext.workspaces.create({ path });
            onPick(workspace.workspaceId);
          } catch (error) {
            console.warn("no-project-sessions: new project failed:", error);
          }
          return;
        }
        // The owner closes the picker and navigates after onPick returns.
        onPick(id === NO_PROJECT_ITEM ? scratchId : id);
        onClose();
      };

      return React.createElement(Menu, {
        open,
        items,
        footer,
        selectedId: selectedId === scratchId ? NO_PROJECT_ITEM : selectedId,
        onSelect: handleSelect,
        onClose,
        anchorRef,
        t,
      });
    }

    // ---- working directory preparation ------------------------------------

    const prepareInFlight = new Map();

    /**
     * Ask the Host to give this session its dated directory, named after the
     * first message. The Host is idempotent: a session already working inside
     * the root keeps its folder, so callers need not track that themselves.
     * @param {string} sessionId - target session.
     * @param {string} text - the first message, used for the folder name.
     * @param {AbortSignal | undefined} signal - caller cancellation.
     * @returns {Promise<string>} the effective working directory.
     */
    async function prepareDirectory(sessionId, text, signal) {
      let response;
      try {
        response = await fetch(PREPARE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, text }),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`创建目录失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`创建目录失败：${payload.error ?? `HTTP ${response.status}`}`);
      }
      return payload.path;
    }

    function waitForPreparation(promise, signal) {
      if (signal === undefined) return promise;
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        promise.then(resolve, reject).then(() => signal.removeEventListener("abort", aborted));
      });
    }

    /**
     * Wrap `conversation.sendSession` so the first message of a no-project
     * session has its folder reserved and committed before the prompt reaches
     * the Host.
     * @param ctx - client root context.
     */
    function patchSendSession(ctx) {
      const conversation = ctx.get("conversation");
      if (conversation === undefined) return;
      // Stable reference: the permanent wrapper below can outlive this ctx.
      const sessions = ctx.sessions;
      const handler = async function sendSessionWithDatedDirectory(
        original, session, text, attachmentIds, mode, signal, accept,
      ) {
        signal?.throwIfAborted();
        const summary = sessions.list.getSnapshot().byId[session.sessionId];
        // The Host decides whether a folder is still needed, so this only has to
        // recognise the section the session belongs to.
        if (isNoProjectCwd(summary?.cwd)) {
          let entry = prepareInFlight.get(session.sessionId);
          if (entry === undefined) {
            const controller = new AbortController();
            entry = { controller, promise: prepareDirectory(session.sessionId, text, controller.signal) };
            prepareInFlight.set(session.sessionId, entry);
            const clearPending = () => {
              if (prepareInFlight.get(session.sessionId) === entry) prepareInFlight.delete(session.sessionId);
            };
            entry.promise.then(clearPending, clearPending);
          }
          // Cancelling one send must not cancel another send sharing preparation.
          await waitForPreparation(entry.promise, signal);
        }
        signal?.throwIfAborted();
        return original.call(this, session, text, attachmentIds, mode, signal, accept);
      };
      // Install the wrapper once and never restore it: reading a function property
      // through the traceable proxy yields a fresh shadow each time, so identity
      // checks cannot undo it. Behavior lives in the replaceable handler instead.
      if (!conversation[PATCH]) {
        const original = conversation.sendSession;
        if (typeof original !== "function") return;
        const wrapper = function sendSessionPermanent(...args) {
          const current = conversation[HANDLER];
          return current === undefined ? original.apply(this, args) : current.call(this, original, ...args);
        };
        conversation[PATCH] = wrapper;
        conversation.sendSession = wrapper;
      }
      conversation[HANDLER] = handler;
      ctx.effect(() => () => {
        if (conversation[HANDLER] === handler) delete conversation[HANDLER];
        for (const entry of prepareInFlight.values()) entry.controller.abort();
        prepareInFlight.clear();
      }, "no-project-sessions: restore conversation.sendSession");
    }

    // ---- settings ---------------------------------------------------------

    /**
     * The plugin's own settings page, contributed to the bundle page's
     * configuration seat. The draft root is set once here: saving writes the
     * row's `config.scratchRoot` through the Host, which restarts this plugin,
     * so later sessions create their folders under the new directory.
     *
     * `plugins.bundle.config` receives no `form` from the Host, so this card
     * saves through the plugin's own route rather than the host's staged-edit
     * machinery. That is deliberate: saving here restarts the row.
     */
    function ScratchRootSettings({ view, t }) {
      const [current, setCurrent] = React.useState("");
      const [value, setValue] = React.useState("");
      const [state, setState] = React.useState({ kind: "loading" });
      const [saving, setSaving] = React.useState(false);
      const savingRef = React.useRef(false);
      const [loaded, setLoaded] = React.useState(false);

      React.useEffect(() => {
        let active = true;
        fetch(CONFIG_PATH, { method: "GET" })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((payload) => {
            if (!active) return;
            const root = typeof payload?.root === "string" ? payload.root : "";
            setCurrent(root);
            setValue(root);
            setLoaded(true);
            setState({ kind: "idle" });
          })
          .catch(() => {
            // Leave `loaded` false: saving is blocked until the real value is
            // known, so an unknown root is never written back as empty.
            if (active) setState({ kind: "error", message: t("settings.loadFailed") });
          });
        return () => { active = false; };
      }, [t]);

      const browse = async () => {
        try {
          const picked = await currentContext.uiWorkspace.pickDirectory();
          if (typeof picked === "string" && picked !== "") setValue(picked);
        } catch (error) {
          console.warn("no-project-sessions: browse failed:", error);
          setState({ kind: "error", message: t("settings.browseFailed") });
        }
      };

      const save = async () => {
        // Guard against a second submit: Enter reaches this path without the
        // disabled attribute, and a duplicate POST would restart the plugin twice.
        if (savingRef.current) return;
        const next = value.trim();
        if (next === "" && !loaded) {
          setState({ kind: "error", message: t("settings.invalid") });
          return;
        }
        savingRef.current = true;
        setSaving(true);
        setState({ kind: "idle" });
        try {
          const response = await fetch(CONFIG_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ root: next }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
          if (typeof payload?.root === "string") {
            setCurrent(payload.root);
            // Adopt it now: the Host restarts this row on save, but this page
            // keeps running, so the picker would otherwise keep using the
            // previous root until the user reloaded.
            setScratchRoot(payload.root, undefined);
          }
          setState({ kind: "saved", message: t("settings.saved") });
        } catch (error) {
          setState({ kind: "error", message: `${t("settings.saveFailed")} ${error instanceof Error ? error.message : String(error)}` });
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      };

      if (view === "summary") return null;
      const status = state.kind === "error"
        ? React.createElement("p", { className: "npsSettingsStatus", "data-tone": "error", role: "alert" }, state.message)
        : state.kind === "saved"
          ? React.createElement("p", { className: "npsSettingsStatus", "data-tone": "ok", role: "status" }, state.message)
          : null;
      return React.createElement(
        "div",
        { className: "npsSettings", "data-plugin-config": "dsh-no-project-sessions" },
        React.createElement("p", { className: "npsSettingsTitle" }, t("settings.title")),
        React.createElement("p", { className: "npsSettingsDesc" }, t("settings.description")),
        current === "" ? null : React.createElement(
          "p",
          { className: "npsSettingsCurrent" },
          `${t("settings.effective")}: `,
          React.createElement("code", null, current),
        ),
        React.createElement(
          "div",
          { className: "npsSettingsRow" },
          React.createElement("input", {
            className: "npsSettingsInput",
            type: "text",
            value,
            spellCheck: false,
            autoComplete: "off",
            placeholder: t("settings.placeholder"),
            "aria-label": t("settings.title"),
            disabled: !loaded || saving,
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter") void save(); },
          }),
          React.createElement(
            "button",
            { type: "button", className: "npsSettingsButton", disabled: saving, onClick: () => { void browse(); } },
            t("settings.browse"),
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "npsSettingsButton",
              "data-primary": "1",
              disabled: !loaded || saving,
              onClick: () => { void save(); },
            },
            saving ? t("settings.saving") : t("settings.save"),
          ),
        ),
        status,
      );
    }

    // ---- wiring -----------------------------------------------------------

    /** Services this client plugin consumes. */
    const inject = ["slots", "locale", "sessions", "workspaces", "uiWorkspace", "conversation", "remote"];

    /**
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      currentContext = ctx;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "no-project-sessions: dictionaries");
      ctx.effect(() => installOwnStyle(), "no-project-sessions: own component style");
      ctx.effect(() => installRecentGroupStyle(), "no-project-sessions: recent section heading");
      // Resolve the configured root before anything classifies a session.
      void loadScratchRoot();
      ctx.effect(() => {
        const revalidate = () => {
          if (document.visibilityState === "hidden") return;
          void loadScratchRoot(true);
        };
        window.addEventListener("focus", revalidate);
        document.addEventListener("visibilitychange", revalidate);
        return () => {
          window.removeEventListener("focus", revalidate);
          document.removeEventListener("visibilitychange", revalidate);
        };
      }, "no-project-sessions: revalidate draft root");

      patchSendSession(ctx);

      ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        name: "plugins.bundle.config",
        key: "dsh-no-project-sessions",
        locale: NS,
      }, ScratchRootSettings));

      ctx.slots.inject("conversation.hero.workspace", () => ctx.slots.register({
        name: "conversation.hero.workspace",
        priority: -1,
        locale: NS,
      }, WorkspaceMenu));
    }

    exports.apply = apply;
    exports.inject = inject;
    /** Settled draft-root read, for tests that must classify paths deterministically. */
    exports.whenScratchRoot = () => loadScratchRoot();
    return module.exports;
  },
});

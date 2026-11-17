// Browser half for dsh-no-project-sessions.
//
// This is a normal client package bundle in the same lazy-CJS format as the
// shipped ui-* packages. It stays additive: it does not replace the shipped
// workspace browser or conversation package. Instead it:
//   1. wraps `conversation.sendSession` so the first message of a no-project
//      session reserves its directory before the prompt reaches the Host;
//   2. replaces the blank-session workspace picker with one that adds a
//      "work without a project" entry selecting the scratch workspace;
//   3. uses a native "最近" workspace group without rewriting host DOM;
//   4. contributes the bundle's own settings page, where the draft root is
//      chosen once.
//
// Path classification is driven by the configured root, read once from the
// Host. Nothing here imports a host Client package: own controls are rendered
// with host theme tokens, because a host primitive's props change between
// releases and a throwing entry blanks this plugin's slot.
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
    const NO_PROJECT_ITEM = "::no-project";
    const NEW_PROJECT_ITEM = "::new-project";
    const prepareInFlight = new Map();

    const zh = {
      "noProject": "不在项目中工作",
      "workspace.defaultName": "工作区",
      "chooseProject": "选择项目",
      "newProject": "新建项目",
      "settings.title": "默认对话目录",
      "settings.description": "无项目会话的目录建在这里，按日期分子目录。修改后插件会重启，此后新建的会话使用新目录。",
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
      "settings.title": "Default conversation directory",
      "settings.description": "No-project sessions create their dated folders here. Saving restarts the plugin; sessions created afterwards use the new directory.",
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

    function cssAttributeValue(value) {
      return String(value).replace(/["\\]/g, "\\$&");
    }

    /**
     * The synthetic workspace is a native group, and this Host version has no
     * public Slot for a group header. Restyle just that one group row so the
     * no-project bucket reads as a sibling section heading ("最近") instead of
     * a project row with a folder icon. The selector keys on the workspace id
     * the browser already exposes on its row.
     */
    function installRecentGroupStyle(ctx) {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-no-project-sessions";
      const render = () => {
        const workspace = hiddenWorkspace();
        if (workspace === undefined) {
          style.textContent = "";
          return;
        }
        const row = `[data-row-key="workspace:${cssAttributeValue(workspace.workspaceId)}"]`;
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
          /* The row's own chrome is the folder glyph and the expand chevron;
             both are the first two spans, while the third carries the label. */
          ${row} > span:nth-child(1),
          ${row} > span:nth-child(2) {
            display: none !important;
          }
          ${row}:hover {
            background: transparent !important;
          }
        `;
      };
      document.head.appendChild(style);
      const off = ctx.workspaces.list.subscribe(render);
      render();
      return () => {
        off();
        style.remove();
      };
    }

    function installScratchChipStyle() {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-no-project-sessions";
      // Only mute the chip to a placeholder look; the label text itself is
      // replaced at the text node by installScratchChipLabel so native font,
      // line height and width stay intact.
      style.textContent = `
        [data-nps-scratch] > button > svg:first-child {
          color: var(--dsw-alias-label-secondary) !important;
        }
        [data-nps-scratch] > button > span[class*="workspaceLabel"] {
          color: var(--dsw-alias-label-secondary) !important;
        }
      `;
      document.head.appendChild(style);
      return () => style.remove();
    }

    /** Styles for this plugin's own menu and settings surfaces (host tokens only). */
    function installOwnComponentStyle() {
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
        .npsMenuRow:hover,
        .npsMenuRow:focus-visible {
          background: var(--dsw-alias-bg-layer-2);
          outline: none;
        }
        .npsMenuRow[data-selected="1"] {
          background: var(--dsw-alias-bg-layer-2);
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

    /**
     * A no-project Session belongs to the hidden scratch Workspace, so the host
     * chip would otherwise show that Workspace's title ("最近"). Replace only
     * that hero chip's text node with a "choose project" placeholder, leaving the
     * stored Workspace title and the sidebar group heading untouched. The chip is
     * not a Slot, so the override is scoped to `heroWorkspaceRow`.
     */
    function installScratchChipLabel(ctx) {
      const placeholderText = () => {
        const lang = String(document.documentElement.lang || navigator.language || "").toLowerCase();
        return lang.startsWith("en") ? en.chooseProject : zh.chooseProject;
      };
      let frame = 0;
      const scan = () => {
        frame = 0;
        const title = hiddenWorkspace()?.title;
        const placeholder = placeholderText();
        for (const row of document.querySelectorAll('[class*="heroWorkspaceRow"]')) {
          const span = row.querySelector("button > span");
          if (span === null) continue;
          const replaced = span.dataset.npsReplaced === "1";
          const current = (span.textContent ?? "").trim();
          const scratch = title !== undefined && (replaced ? span.dataset.npsOriginal === title : current === title);
          if (scratch) {
            if (!replaced) {
              span.dataset.npsOriginal = span.textContent ?? "";
              span.dataset.npsReplaced = "1";
            }
            if ((span.textContent ?? "").trim() !== placeholder) span.textContent = placeholder;
            row.setAttribute("data-nps-scratch", "");
          } else {
            if (replaced) {
              if (current === placeholder) span.textContent = span.dataset.npsOriginal ?? "";
              delete span.dataset.npsReplaced;
              delete span.dataset.npsOriginal;
            }
            row.removeAttribute("data-nps-scratch");
          }
        }
      };
      const schedule = () => {
        if (frame === 0) frame = requestAnimationFrame(scan);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const offSessions = ctx.sessions.list.subscribe(schedule);
      const offWorkspaces = ctx.workspaces.list.subscribe(schedule);
      schedule();
      return () => {
        observer.disconnect();
        offSessions();
        offWorkspaces();
        if (frame !== 0) cancelAnimationFrame(frame);
        for (const span of document.querySelectorAll('[class*="heroWorkspaceRow"] span[data-nps-replaced="1"]')) {
          if ((span.textContent ?? "").trim() === placeholderText()) {
            span.textContent = span.dataset.npsOriginal ?? "";
          }
          delete span.dataset.npsReplaced;
          delete span.dataset.npsOriginal;
        }
        for (const row of document.querySelectorAll('[class*="heroWorkspaceRow"][data-nps-scratch]')) {
          row.removeAttribute("data-nps-scratch");
        }
      };
    }

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

    /**
     * Self-contained dropdown. Client plugins must not import host Client
     * packages (their props change without notice and a throwing entry blanks
     * the slot), so this renders its own popover: portal to the document body,
     * positioned against the trigger, with Escape and outside-click dismissal,
     * arrow-key navigation, and the host theme tokens. Behaviour and markup
     * mirror the host's menu rather than importing it.
     */
    function Menu({ open, items, footer, selectedId, onSelect, onClose, anchorRef, t }) {
      const surfaceRef = React.useRef(null);
      const [placement, setPlacement] = React.useState(null);
      const rows = React.useMemo(
        () => [...items, ...(footer ?? [])],
        [items, footer],
      );

      // Follow the trigger: anchor under it, flipping above when the viewport
      // leaves no room below. Recompute on scroll and resize while open.
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
        // A second pass after paint sizes the surface for the flip decision.
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
            onClick: () => { onSelect(item.id); },
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
            // The trigger toggles the menu; a pointerdown on it must reach the
            // trigger's own handler instead of being treated as an outside click.
            onPointerDown: (event) => event.stopPropagation(),
          },
          rows.map(row),
        ),
        document.body,
      );
    }

    /**
     * Replaces the host workspace picker (shadows it at priority -1) so the menu
     * gains "new project" and "work without a project" entries. New project uses
     * the public pick-directory + create-workspace APIs; the latter selects the
     * scratch workspace.
     */
    function WorkspaceMenu({ open, selectedId, onPick, onClose, anchorRef, useWorkspaces, t }) {
      const workspaces = useWorkspaces((state) => state.items) ?? [];
      // Keep the chip's own toggle working: the host Menu closes on any document
      // pointerdown outside its root, and the chip button is outside it. While the
      // menu is open, swallow the chip's pointerdown so that handler does not fire
      // before the chip's click toggles it shut.
      React.useEffect(() => {
        const element = anchorRef?.current;
        if (!open || element === null || element === undefined) return undefined;
        const swallow = (event) => event.stopPropagation();
        element.addEventListener("pointerdown", swallow, true);
        return () => element.removeEventListener("pointerdown", swallow, true);
      }, [open, anchorRef]);
      const scratchWorkspace = hiddenWorkspace();
      const scratchId = scratchWorkspace?.workspaceId;
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

    let currentContext;
    // The effective draft root, read once from the Host. The setting can only
    // change through the plugin's page, which restarts the plugin, so a cached
    // value stays correct for this page's whole lifetime.
    let scratchRoot = "";
    let scratchRootLoaded = false;
    let scratchRootRequest;

    function homePath() {
      return currentContext?.remote?.$host?.home ?? "";
    }

    /** Read the effective draft root from the Host; cached after the first answer. */
    function loadScratchRoot() {
      if (scratchRootLoaded) return Promise.resolve(scratchRoot);
      if (scratchRootRequest === undefined) {
        scratchRootRequest = fetch(CONFIG_PATH, { method: "GET" })
          .then((response) => (response.ok ? response.json() : {}))
          .then((payload) => {
            scratchRoot = typeof payload?.root === "string" ? payload.root : "";
            scratchRootLoaded = scratchRoot !== "";
            return scratchRoot;
          })
          .catch(() => scratchRoot)
          .finally(() => { scratchRootRequest = undefined; });
      }
      return scratchRootRequest;
    }

    /**
     * Settled state of the root read, so a caller that must classify paths can
     * await resolution instead of racing the first fetch.
     */
    let scratchRootSettled = null;

    function whenScratchRoot() {
      if (scratchRootSettled === null) scratchRootSettled = loadScratchRoot();
      return scratchRootSettled;
    }

    /**
     * Whether the root is already known, so a caller can classify paths without
     * yielding. Only the very first send has to wait for the Host's answer.
     */
    function scratchRootReady() {
      return scratchRootLoaded;
    }

    /**
     * The configured draft root. Before the Host answers (or when it cannot),
     * fall back to the historical default so sessions are never misclassified.
     */
    function basePath() {
      if (scratchRoot !== "") return normalize(scratchRoot);
      const home = homePath();
      return home === "" ? "" : normalize(`${home}/Documents/dsh`);
    }

    function isScratchPath(path) {
      if (typeof path !== "string" || path === "") return false;
      const normalized = normalize(path);
      const base = basePath();
      if (base === "") return false;
      return normalized === base;
    }

    function hiddenWorkspace() {
      const items = currentContext?.workspaces?.list?.getSnapshot()?.items ?? [];
      const base = basePath();
      if (base === "") return undefined;
      return items.find((workspace) => normalize(workspace.path) === base);
    }

    function isScratchSummary(summary) {
      return isScratchPath(summary?.cwd);
    }

    /**
     * Whether this scratch Session already has a reserved dated directory
     * committed as its working directory. `workingDirectory` is a
     * summary-excluded projection in this Host version, so the live Session's
     * own projection values are the authority; the list row is only a fallback
     * for a summary that still carries it.
     */
    function hasPreparedDirectory(summary, sessionId) {
      const base = normalize(summary?.cwd ?? "");
      if (!isScratchPath(base)) return false;
      const fromSummary = summary?.projectionValues?.workingDirectory;
      // `scope(id)` yields a Context, not a Session face; the retained binding
      // is what carries the live projections.
      const binding = typeof sessionId === "string" ? currentContext?.sessions?.binding?.(sessionId) : undefined;
      const face = binding?.session?.projections?.faceOf?.("workingDirectory");
      const fromSession = face?.getSnapshot?.();
      const effective = typeof fromSession === "string" ? fromSession : fromSummary;
      return typeof effective === "string"
        && normalize(effective) !== base
        && normalize(effective).startsWith(`${base}/`);
    }

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
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
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

    function patchSendSession(ctx) {
      const conversation = ctx.get("conversation");
      if (conversation === undefined) return;
      // Stable reference: the permanent wrapper below can outlive this ctx.
      const sessions = ctx.sessions;
      const handler = async function sendSessionWithScratchDirectory(original, session, text, attachmentIds, mode, signal, accept) {
        signal?.throwIfAborted();
        // The very first send can arrive before the Host has answered which
        // directory is scratch; classifying it against the fallback would
        // prepare the wrong path, so wait for that one read. Once it is known
        // the path takes no suspension at all.
        if (!scratchRootReady()) await whenScratchRoot();
        signal?.throwIfAborted();
        const summary = sessions.list.getSnapshot().byId[session.sessionId];
        if (isScratchSummary(summary) && !hasPreparedDirectory(summary, session.sessionId)) {
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

    /**
     * The plugin's own settings page, contributed to the bundle page's
     * configuration seat. The draft root is set once here: saving writes the
     * row's `config.scratchRoot` through the Host, which restarts this plugin,
     * so later sessions create their folders under the new directory.
     */
    function ScratchRootSettings({ view, form, t }) {
      const [current, setCurrent] = React.useState("");
      const [value, setValue] = React.useState("");
      const [state, setState] = React.useState({ kind: "loading" });
      const [saving, setSaving] = React.useState(false);
      // Mirrors `saving` for the Enter path, which the disabled attribute does
      // not cover; a duplicate POST would restart the plugin twice.
      const savingRef = React.useRef(false);
      // Distinguishes "the field is empty because the Host said so" from "the
      // read failed", which must not be saved as an empty value.
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
        // An empty value clears the field, restoring the built-in default.
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
          if (typeof payload?.root === "string") setCurrent(payload.root);
          // The save restarts this plugin, which unmounts this card, so this
          // message is only reachable when the row is not restarting in place.
          setState({ kind: "saved", message: t("settings.saved") });
        } catch (error) {
          setState({ kind: "error", message: `${t("settings.saveFailed")} ${error instanceof Error ? error.message : String(error)}` });
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      };

      // Only the page view carries this plugin's form; a summary read renders nothing.
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
              // Saving stays unavailable until the real value is known, so an
              // unknown root is never written back as the default.
              disabled: !loaded || saving,
              onClick: () => { void save(); },
            },
            saving ? t("settings.saving") : t("settings.save"),
          ),
        ),
        status,
      );
    }

    /** Services this client plugin consumes. */
    const inject = [
      "slots",
      "locale",
      "sessions",
      "workspaces",
      "uiWorkspace",
      "conversation",
      "remote",
    ];

    /**
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      currentContext = ctx;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "no-project-sessions: dictionaries");
      ctx.effect(() => installScratchChipStyle(), "no-project-sessions: scratch chip style");
      ctx.effect(() => installOwnComponentStyle(), "no-project-sessions: own component style");
      ctx.effect(() => installScratchChipLabel(ctx), "no-project-sessions: scratch chip label");
      ctx.effect(() => installRecentGroupStyle(ctx), "no-project-sessions: recent group style");
      patchSendSession(ctx);
      // Resolve the configured root before any path classification runs.
      void loadScratchRoot().then(() => { if (scratchRoot !== "") ctx.workspaces?.list?.getSnapshot?.(); });

      // This bundle's own configuration on its Plugins page, keyed by the
      // bundle's package name; the draft root is chosen once and saved there.
      ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        name: "plugins.bundle.config",
        key: "dsh-no-project-sessions",
        locale: NS,
      }, ScratchRootSettings));

      // Replace the host workspace menu with one that appends a "work without a
      // project" item. A lower priority shadows the shipped entry (priority 0).
      ctx.slots.inject("conversation.hero.workspace", () => ctx.slots.register({
        name: "conversation.hero.workspace",
        priority: -1,
        locale: NS,
      }, WorkspaceMenu));

    }

    exports.apply = apply;
    exports.inject = inject;
    /** Settled draft-root read, for tests that must classify paths deterministically. */
    exports.whenScratchRoot = whenScratchRoot;
    return module.exports;
  },
});

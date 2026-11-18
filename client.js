/**
 * Task center: one sidebar entry listing every Session that is running or
 * waiting for the user, plus frame-wide reminders when an Agent asks a
 * question or finishes away from the current view.
 *
 * Everything is derived from the Client's own Session list, Session status
 * source, and Workspace snapshot: the plugin keeps no durable state and never
 * appends Session events. Clicking a row or a reminder navigates through
 * `uiWorkspace.openSession`, the same action the sidebar uses.
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-center',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

    const NS = 'task-center';
    const VERSION = '1.7.0';
    const TOAST_MS = 15000;
    const MAX_TOASTS = 3;
    /** Finished Sessions stay listed for this long, and only while unread. */
    const COMPLETED_WINDOW_MS = 30 * 60 * 1000;

    /* ------------------------------------------------------------------ copy */

    const en = {
      'action.open': 'Task center',
      'action.openAria': 'Task center: {waiting} waiting, {running} running',
      'panel.title': 'Task center',
      'panel.summary': '{waiting} waiting · {running} running · {completed} finished',
      'panel.group.waiting': 'Waiting for you',
      'panel.group.running': 'Running',
      'panel.group.completed': 'Finished in the last 30 minutes',
      'panel.empty': 'No task is running or waiting right now.',
      'panel.close': 'Close task center',
      'state.waiting': 'Needs your answer',
      'state.approval': 'Needs your approval',
      'state.planReview': 'Needs plan review',
      'state.pendingOther': 'Needs your input',
      'state.running': 'Running',
      'state.completed': 'Finished',
      'toast.title.question': 'An Agent is waiting for your answer',
      'toast.title.approval': 'An Agent is waiting for your approval',
      'toast.title.planReview': 'An Agent is waiting for plan review',
      'toast.title.pending': 'An Agent is waiting for your input',
      'toast.title.completed': 'A task finished',
      'toast.dismiss': 'Dismiss reminder',
      'native.label': 'System notifications',
      'native.status.granted': 'Allowed',
      'native.status.default': 'Not requested yet',
      'native.status.denied': 'Blocked — using in-page cards',
      'native.status.unsupported': 'Unavailable here',
      'native.status.failed': 'Failed to send',
      'native.lastReminder': 'Last reminder',
      'native.channel.system': 'system notification',
      'native.channel.page': 'in-page card',
      'sort.label': 'Sort projects by recent activity',
      'sort.hint': 'Project order follows the Session with the most recent activity; a manual drag is overridden by the next activity.',
      'project.unassigned': 'Ungrouped',
      'session.untitled': 'Untitled session',
      'time.now': 'just now',
      'time.minutes': '{count} min ago',
      'time.hours': '{count} h ago',
      'time.days': '{count} d ago',
    };

    const zh = {
      'action.open': '任务中心',
      'action.openAria': '任务中心：{waiting} 个等待处理，{running} 个正在运行',
      'panel.title': '任务中心',
      'panel.summary': '{waiting} 个等待处理 · {running} 个正在运行 · {completed} 个已完成',
      'panel.group.waiting': '等待你处理',
      'panel.group.running': '正在运行',
      'panel.group.completed': '30 分钟内完成',
      'panel.empty': '当前没有正在运行或等待处理的任务。',
      'panel.close': '关闭任务中心',
      'state.waiting': '等你回答',
      'state.approval': '等你批准',
      'state.planReview': '等你确认计划',
      'state.pendingOther': '等你处理',
      'state.running': '正在运行',
      'state.completed': '已完成',
      'toast.title.question': 'Agent 在等你回答',
      'toast.title.approval': 'Agent 在等你批准',
      'toast.title.planReview': 'Agent 在等你确认计划',
      'toast.title.pending': 'Agent 在等你处理',
      'toast.title.completed': '任务已完成',
      'toast.dismiss': '关闭提醒',
      'native.label': '系统通知',
      'native.status.granted': '已允许',
      'native.status.default': '待授权',
      'native.status.denied': '已拒绝，改用页内提醒',
      'native.status.unsupported': '当前环境不支持',
      'native.status.failed': '发送失败',
      'native.lastReminder': '最近提醒',
      'native.channel.system': '系统通知',
      'native.channel.page': '页内卡片',
      'sort.label': '项目按最近活动排序',
      'sort.hint': '项目顺序跟随最近有活动的会话；在此开启时，手动拖动会在下次活动后被覆盖。',
      'project.unassigned': '未分组',
      'session.untitled': '未命名会话',
      'time.now': '刚刚',
      'time.minutes': '{count} 分钟前',
      'time.hours': '{count} 小时前',
      'time.days': '{count} 天前',
    };

    /* ----------------------------------------------------------------- model */

    /** Pending-interaction kinds with their own copy; every other kind shares one label. */
    const PENDING_LABEL = {
      question: 'state.waiting',
      approval: 'state.approval',
      'plan-review': 'state.planReview',
    };
    const PENDING_TOAST = {
      question: 'toast.title.question',
      approval: 'toast.title.approval',
      'plan-review': 'toast.title.planReview',
    };

    /** Normalize a pending interaction to a display kind; unknown kinds stay generic. */
    function pendingKind(pending) {
      const kind = pending && typeof pending.kind === 'string' ? pending.kind : '';
      return kind === 'question' || kind === 'approval' || kind === 'plan-review' ? kind : 'pending';
    }

    /** Directory basename for a Session without a Workspace title. */
    function basename(path) {
      if (typeof path !== 'string' || path === '') return '';
      const parts = path.split(/[\\/]+/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : '';
    }

    /** Session id to owning Workspace title, first account wins. */
    function workspaceTitles(workspaces) {
      const owners = new Map();
      const items = workspaces && Array.isArray(workspaces.items) ? workspaces.items : [];
      for (const workspace of items) {
        const label = (typeof workspace.title === 'string' && workspace.title !== '')
          ? workspace.title
          : basename(workspace.path);
        for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
          if (!owners.has(sessionId)) owners.set(sessionId, label);
        }
      }
      return owners;
    }

    /** The Session shown in the main view, or undefined while none is retained. */
    function mainSessionId(byId) {
      for (const id of Object.keys(byId)) {
        const row = byId[id];
        if (row && (row.retainedBy && (row.retainedBy.mainView ?? 0) > 0)) return id;
      }
      return undefined;
    }

    /**
     * Unanswered `ask_user_question` calls carried by the Session summary.
     * A summary block reports them for every listed Session, including ones this
     * page never opened, which is why the projection is read instead of the
     * interaction status alone.
     */
    function projectedQuestions(summary) {
      const values = summary && summary.projectionValues;
      const view = values && values.userQuestions;
      return view && Array.isArray(view.active) ? view.active : [];
    }

    /** One active Session reduced to the facts a row or reminder needs. */
    // { id, title, project, kind, pendingKey, updatedAt }

    /**
     * Reduce the three Client sources to the Sessions worth showing.
     * Blank placeholders, subagent children, and archived Sessions are omitted.
     * Idle Sessions stay in `rows` (kind `idle`) so reminder bookkeeping sees
     * every listed Session; the panel only renders the three active groups.
     * @param {{ list: unknown, statuses: unknown, workspaces: unknown, t: (key: string, params?: object) => string }} input
     */
    function buildModel({ list, statuses, workspaces, t, now = Date.now() }) {
      const byId = (list && list.byId) || {};
      const ids = list && Array.isArray(list.ids) ? list.ids : Object.keys(byId);
      const archived = new Set((workspaces && workspaces.archivedSessionIds) || []);
      const owners = workspaceTitles(workspaces);
      const currentId = mainSessionId(byId);
      const rows = [];

      for (const id of ids) {
        const summary = byId[id];
        if (!summary) continue;
        if (summary.origin === 'subagent') continue;
        if (summary.blank === true) continue;
        if (archived.has(id)) continue;

        const status = statuses && typeof statuses.get === 'function' ? statuses.get(id) : undefined;
        const pending = status && status.pendingInteraction ? status.pendingInteraction : undefined;
        const questions = projectedQuestions(summary);
        const running = typeof (status && status.running) === 'boolean'
          ? status.running
          : summary.running === true;
        const finishedAt = typeof summary.updatedAt === 'number' ? summary.updatedAt : 0;
        // "Unread, finished recently": older completions are history, not work.
        const completed = !!(status && status.completionUnread) && !running && !pending
          && questions.length === 0
          && finishedAt > 0 && now - finishedAt <= COMPLETED_WINDOW_MS;

        const kind = pending || questions.length > 0
          ? 'waiting'
          : running ? 'running' : completed ? 'completed' : 'idle';

        // Every outstanding ask gets its own stable token, so a second question
        // is announced while the same question never is. Question tokens use the
        // call id, which the Host never reuses.
        const tokens = [];
        if (pending) tokens.push(`interaction:${typeof pending.key === 'string' ? pending.key : 'pending'}`);
        for (const question of questions) {
          tokens.push(`call:${question && typeof question.callId === 'string' ? question.callId : '?'}`);
        }

        rows.push({
          id,
          kind,
          title: typeof summary.title === 'string' && summary.title !== ''
            ? summary.title
            : (typeof summary.displayTitle === 'string' && summary.displayTitle !== ''
              ? summary.displayTitle
              : t('session.untitled')),
          project: owners.get(id) || basename(summary.cwd) || t('project.unassigned'),
          pendingKind: pending
            ? pendingKind(pending)
            : questions.length > 0 ? 'question' : undefined,
          tokens,
          updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
        });
      }

      rows.sort((left, right) => right.updatedAt - left.updatedAt);

      return {
        currentId,
        rows,
        waiting: rows.filter(row => row.kind === 'waiting'),
        running: rows.filter(row => row.kind === 'running'),
        completed: rows.filter(row => row.kind === 'completed'),
        bySession: new Map(rows.map(row => [row.id, row])),
      };
    }

    /** Relative time label; coarse on purpose, the panel re-renders each minute. */
    function relativeTime(t, timestamp) {
      if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
      const diff = Date.now() - timestamp;
      if (diff < 60000) return t('time.now');
      const minutes = Math.floor(diff / 60000);
      if (minutes < 60) return t('time.minutes', { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t('time.hours', { count: hours });
      return t('time.days', { count: Math.floor(hours / 24) });
    }

    /* --------------------------------------------------- workspace order */

    const SORT_PREFERENCE_KEY = 'dsh.task-center.workspace-sort';

    /** Read the stored order preference; recency is the default. */
    function readSortMode() {
      try {
        return window.localStorage.getItem(SORT_PREFERENCE_KEY) === 'manual' ? 'manual' : 'recent';
      } catch {
        return 'recent';
      }
    }

    /** Persist the order preference; an unavailable store keeps the run in memory. */
    function writeSortMode(mode) {
      try {
        window.localStorage.setItem(SORT_PREFERENCE_KEY, mode);
      } catch {
        // A read-only store only loses the preference across reloads.
      }
    }

    /** Minimal observable value shared by the plugin's own components. */
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener) };
        },
        set: (next) => {
          if (Object.is(next, value)) return;
          value = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /** Tiny observable so the switch and the sorter share one value. */
    function createSortPreference() {
      let value = readSortMode();
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener) };
        },
        set: (next) => {
          if (next !== 'recent' && next !== 'manual') return;
          if (next === value) return;
          value = next;
          writeSortMode(next);
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /**
     * Workspace ids ordered by the most recent activity of their Sessions.
     * A Workspace keyed by its newest non-archived, non-subagent Session time;
     * ties and empty Workspaces keep their current relative order.
     */
    function desiredWorkspaceOrder(workspaces, sessions) {
      const items = workspaces && Array.isArray(workspaces.items) ? workspaces.items : [];
      const byId = (sessions && sessions.byId) || {};
      const archived = new Set((workspaces && workspaces.archivedSessionIds) || []);
      const recency = new Map();
      for (const workspace of items) {
        let newest = 0;
        for (const sessionId of workspace.sessionIds || []) {
          const summary = byId[sessionId];
          if (!summary || summary.origin === 'subagent' || summary.blank === true) continue;
          if (archived.has(sessionId)) continue;
          if (typeof summary.updatedAt === 'number' && summary.updatedAt > newest) newest = summary.updatedAt;
        }
        recency.set(workspace.workspaceId, newest);
      }
      return items
        .map((workspace, index) => ({ id: workspace.workspaceId, index, newest: recency.get(workspace.workspaceId) || 0 }))
        .sort((left, right) => (right.newest - left.newest) || (left.index - right.index))
        .map(entry => entry.id);
    }

    /**
     * Keep the sidebar's Workspace order following recent activity while the
     * preference is `recent`. Only the Workspaces that are out of place move, so
     * a settled order costs no Host writes.
     * @param ctx - injected Cordis scope with `sessions` and `workspaces`.
     * @param preference - shared sort preference.
     * @returns disposer.
     */
    function createWorkspaceSorter(ctx, preference) {
      let timer;
      let running = false;
      let rerun = false;
      let disposed = false;
      let warned = false;
      let unstable = 0;
      let cooldownUntil = 0;

      const move = async (workspaceId, beforeWorkspaceId) => {
        if (typeof ctx.workspaces.insertBefore === 'function') {
          await ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId);
          return;
        }
        const remote = ctx.get('remote');
        const result = await remote.workspace.insertBefore(
          beforeWorkspaceId === undefined
            ? { workspaceId }
            : { workspaceId, beforeWorkspaceId },
        );
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      };

      const reorder = async () => {
        if (preference.getSnapshot() !== 'recent') return;
        const workspaces = ctx.workspaces.list.getSnapshot();
        const current = (workspaces.items || []).map(workspace => workspace.workspaceId);
        if (current.length < 2) return;
        const desired = desiredWorkspaceOrder(workspaces, ctx.sessions.list.getSnapshot());
        if (desired.length !== current.length || desired.every((id, index) => id === current[index])) return;

        // Move only what is out of place: walk the desired order left to right and
        // put each mismatch before its desired successor.
        const next = current.slice();
        const moves = [];
        for (let index = 0; index < desired.length; index += 1) {
          if (next[index] === desired[index]) continue;
          const at = next.indexOf(desired[index]);
          if (at < 0) continue;
          next.splice(at, 1);
          next.splice(index, 0, desired[index]);
          moves.push([desired[index], next[index + 1]]);
        }
        for (const [workspaceId, beforeWorkspaceId] of moves) {
          try {
            await move(workspaceId, beforeWorkspaceId);
          } catch (error) {
            if (!warned) {
              warned = true;
              console.warn('[task-center] reordering Workspaces failed:', error);
            }
            return;
          }
        }

        // A Host that keeps a different order must not be fought in a loop.
        const settled = (ctx.workspaces.list.getSnapshot().items || []).map(workspace => workspace.workspaceId);
        if (settled.length === desired.length && settled.every((id, index) => id === desired[index])) {
          unstable = 0;
          return;
        }
        unstable += 1;
        if (unstable < 2) return;
        unstable = 0;
        cooldownUntil = Date.now() + 60000;
        if (!warned) {
          warned = true;
          console.warn('[task-center] the Host kept a different Workspace order; sorting paused for a minute');
        }
      };

      const flush = async () => {
        if (disposed) return;
        if (Date.now() < cooldownUntil) return;
        if (running) {
          rerun = true;
          return;
        }
        running = true;
        try {
          await reorder();
        } finally {
          running = false;
          if (rerun && !disposed) {
            rerun = false;
            schedule(0);
          }
        }
      };

      const schedule = (delay = 900) => {
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(() => { void flush() }, delay);
      };

      const stops = [
        ctx.sessions.list.subscribe(() => { schedule() }),
        ctx.workspaces.list.subscribe(() => { schedule() }),
        preference.subscribe(() => { schedule(0) }),
      ];
      schedule(0);

      return () => {
        disposed = true;
        clearTimeout(timer);
        for (const stop of stops) stop();
      };
    }

    /* ----------------------------------------------------------------- style */

    const CSS = `
.tc-layer { position: relative; display: flex; align-items: center; width: 100%; height: 42px; margin: 8px 0 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", sans-serif; }
.tc-layer[data-rail] { width: 36px; height: 36px; margin: 0; }
.tc-trigger { display: inline-flex; align-items: center; gap: 8px; width: calc(100% + 4px); height: 42px; margin: 0 -2px; padding: 0 10px; border: none; border-radius: 10px; background: transparent; color: var(--dsw-alias-label-primary, #1d1d1f); font: inherit; font-size: 13px; line-height: 18px; letter-spacing: -0.01em; text-align: left; cursor: pointer; transition: background-color 120ms ease; overflow: hidden; }
.tc-trigger:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.12)); }
.tc-trigger[data-open] { background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.16)); }
.tc-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0a84ff); outline-offset: -1px; }
.tc-layer[data-rail] .tc-trigger { justify-content: center; gap: 0; width: 36px; height: 36px; margin: 0; padding: 0; border-radius: 11px; }
.tc-glyph { display: inline-flex; flex: none; align-items: center; justify-content: center; }
.tc-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-badge { flex: none; margin-left: auto; min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--dsw-alias-state-warn-primary, #ff9f0a); color: #fff; font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }
.tc-rail-dot { position: absolute; top: 1px; right: 1px; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary, #ff9f0a); }
.tc-panel { position: fixed; z-index: 40; display: flex; flex-direction: column; width: 360px; max-width: calc(100vw - 24px); max-height: 62vh; overflow: hidden; border-radius: 16px; background: var(--dsw-alias-bg-overlay, #fbfbfd); backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24), 0 0 0 0.5px var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12)); animation: tc-rise 160ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.tc-panel:focus { outline: none; }
@keyframes tc-rise { from { opacity: 0; transform: translateY(6px) scale(0.985); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .tc-panel, .tc-toast { animation: none; } .tc-trigger, .tc-row, .tc-switch, .tc-switch-thumb { transition: none; } }
.tc-head { flex: none; display: flex; flex-direction: column; gap: 3px; padding: 16px 16px 10px; }
.tc-head-row { display: flex; align-items: center; gap: 8px; }
.tc-title { flex: 1; min-width: 0; margin: 0; font-size: 17px; font-weight: 600; line-height: 22px; letter-spacing: -0.02em; color: var(--dsw-alias-label-primary, #1d1d1f); }
.tc-summary { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary, #6e6e73); }
.tc-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 50%; background: transparent; color: var(--dsw-alias-label-secondary, #6e6e73); font: inherit; font-size: 15px; line-height: 1; cursor: pointer; transition: background-color 120ms ease; }
.tc-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.14)); color: var(--dsw-alias-label-primary, #1d1d1f); }
.tc-close:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0a84ff); outline-offset: 1px; }
.tc-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 10px; }
.tc-group { margin: 12px 8px 6px; font-size: 12px; font-weight: 500; line-height: 16px; letter-spacing: -0.01em; color: var(--dsw-alias-label-secondary, #6e6e73); }
.tc-rows { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border-radius: 12px; background: var(--dsw-alias-bg-layer-2, rgba(120, 120, 128, 0.08)); overflow: hidden; }
.tc-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border: none; border-radius: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background-color 120ms ease; }
.tc-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.12)); }
.tc-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0a84ff); outline-offset: -2px; }
.tc-rows > li + li .tc-row { box-shadow: inset 0 0.5px 0 var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08)); }
.tc-row:hover .tc-row-title { text-decoration: none; }
.tc-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
.tc-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.tc-row-title { overflow: hidden; font-size: 13px; line-height: 18px; letter-spacing: -0.01em; color: var(--dsw-alias-label-primary, #1d1d1f); text-overflow: ellipsis; white-space: nowrap; }
.tc-row-meta { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary, #6e6e73); }
.tc-row-project { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-row-time { flex: none; }
.tc-state { flex: none; font-size: 12px; line-height: 16px; }
.tc-chevron { flex: none; color: var(--dsw-alias-label-secondary, #6e6e73); font-size: 15px; line-height: 16px; opacity: 0.5; }
.tc-empty { margin: 20px 12px 24px; font-size: 13px; line-height: 18px; text-align: center; color: var(--dsw-alias-label-secondary, #6e6e73); }
.tc-foot { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 10px 16px 14px; border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08)); }
.tc-foot-row { display: flex; align-items: center; gap: 10px; }
.tc-foot-note { margin: 0; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary, #6e6e73); }
.tc-foot-label { flex: 1; min-width: 0; font-size: 12px; line-height: 16px; letter-spacing: -0.01em; color: var(--dsw-alias-label-secondary, #6e6e73); }
.tc-switch { flex: none; display: inline-flex; align-items: center; width: 40px; height: 24px; padding: 2px; border: none; border-radius: 12px; background: var(--dsw-alias-border-l2, rgba(120, 120, 128, 0.32)); cursor: pointer; transition: background-color 160ms ease; }
.tc-switch[data-on] { background: var(--dsw-alias-brand-primary, #0a84ff); }
.tc-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0a84ff); outline-offset: 2px; }
.tc-switch-thumb { display: block; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.tc-switch[data-on] .tc-switch-thumb { transform: translateX(16px); }
.tc-toasts { position: fixed; right: 16px; bottom: 16px; z-index: 60; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", sans-serif; }
.tc-toast { display: flex; align-items: stretch; gap: 2px; width: 320px; max-width: calc(100vw - 32px); overflow: hidden; border-radius: 14px; background: var(--dsw-alias-bg-overlay, #fbfbfd); backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); box-shadow: 0 18px 44px rgba(0, 0, 0, 0.22), 0 0 0 0.5px var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12)); pointer-events: auto; animation: tc-rise 160ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.tc-toast-accent { flex: none; width: 3px; }
.tc-toast-body { flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: 6px; padding: 11px 8px 11px 12px; }
.tc-toast-open { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; padding: 0; border: none; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.tc-toast-open:hover .tc-toast-title { text-decoration: underline; }
.tc-toast-kind { font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: -0.01em; }
.tc-toast-title { overflow: hidden; font-size: 13px; line-height: 18px; letter-spacing: -0.01em; color: var(--dsw-alias-label-primary, #1d1d1f); text-overflow: ellipsis; white-space: nowrap; }
.tc-toast-project { overflow: hidden; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary, #6e6e73); text-overflow: ellipsis; white-space: nowrap; }
.tc-toast-open:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #0a84ff); outline-offset: 2px; border-radius: 6px; }
`;

    /** Global stylesheet for both slots; scoped by the `tc-` prefix. */
    function Styles() {
      return h('style', { 'data-task-center': '' }, CSS);
    }

    /** Tone color per row kind, resolved from theme tokens with a readable fallback. */
    const TONE = {
      waiting: 'var(--dsw-alias-state-warn-primary, #d97706)',
      running: 'var(--dsw-alias-brand-primary, #3b82f6)',
      completed: 'var(--dsw-alias-state-success-primary, #16a34a)',
    };

    function toneOf(row) {
      return row.kind === 'waiting' ? TONE.waiting : row.kind === 'running' ? TONE.running : TONE.completed;
    }

    function stateLabel(t, row) {
      if (row.kind === 'running') return t('state.running');
      if (row.kind === 'completed') return t('state.completed');
      return t(PENDING_LABEL[row.pendingKind] || 'state.pendingOther');
    }

    /** Three condensed task bars; the count badge and dot carry the state. */
    function TaskGlyph({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 20 20', 'aria-hidden': true, focusable: false,
        style: { display: 'block' },
      },
      h('rect', { x: 3, y: 3.6, width: 10, height: 2.2, rx: 1.1, fill: 'currentColor' }),
      h('rect', { x: 3, y: 8.9, width: 14, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.7 }),
      h('rect', { x: 3, y: 14.2, width: 7, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.45 }));
    }

    /* ------------------------------------------------------- sidebar entry */

    /**
     * `sidebar.footer.action` occupant: the trigger and its anchored panel.
     * @param props - slot props plus the injected navigation action.
     */
    function FooterActionView(props) {
      const {
        wide, t, useSessions, useSessionStatus, useWorkspaces, openSession,
        useWorkspaceSort, setWorkspaceSort, useNativePermission, useLastReminder,
      } = props;
      const list = useSessions(state => state);
      const statuses = useSessionStatus(snapshot => snapshot);
      const workspaces = useWorkspaces(snapshot => snapshot);

      // One clock drives both relative times and the completed window, so an
      // opened panel ages its rows instead of freezing them.
      const [now, setNow] = useState(() => Date.now());
      const model = useMemo(
        () => buildModel({ list, statuses, workspaces, t, now }),
        [list, statuses, workspaces, t, now],
      );

      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState(undefined);
      const nativeState = useNativePermission(value => value);
      const lastReminder = useLastReminder(value => value);
      const rootRef = useRef(null);
      const triggerRef = useRef(null);
      const panelRef = useRef(null);

      // An omitted `wide` keeps the expanded layout rather than a rail-sized one.
      const rail = wide === false;
      const waitingCount = model.waiting.length;
      const sortOn = useWorkspaceSort(value => value) === 'recent';

      const close = useCallback(() => { setOpen(false) }, []);

      // The panel is fixed (the sidebar clips overflow), so it hugs the trigger.
      // Anchor it on resize, on rail/width changes, and on any ancestor scroll.
      useLayoutEffect(() => {
        if (!open) return undefined;
        const place = () => {
          const rect = rootRef.current && rootRef.current.getBoundingClientRect();
          if (!rect) return;
          const left = rail ? rect.right + 8 : rect.left;
          const width = 380;
          setAnchor({
            left: Math.max(8, Math.min(left, (window.innerWidth || 0) - width - 8)),
            bottom: Math.max(8, window.innerHeight - rect.top + 8),
          });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [open, rail]);

      // Move focus into the panel so the list is reachable from the keyboard.
      useEffect(() => {
        if (!open) return;
        const panel = panelRef.current;
        if (panel) panel.focus();
      }, [open]);

      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const root = rootRef.current;
          if (root && event.target instanceof Node && root.contains(event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          setOpen(false);
          const trigger = triggerRef.current;
          if (trigger) trigger.focus();
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown);
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      // Keep relative times and the completed window honest while it is open.
      useEffect(() => {
        if (!open) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => { setNow(Date.now()) }, 30000);
        return () => { clearInterval(timer) };
      }, [open]);

      const navigate = (sessionId) => {
        openSession(sessionId);
        setOpen(false);
      };

      const toggleSort = () => {
        if (typeof setWorkspaceSort === 'function') setWorkspaceSort(sortOn ? 'manual' : 'recent');
      };


      const renderRow = (row) => h('li', { key: row.id }, h('button', {
        type: 'button',
        className: 'tc-row',
        onClick: () => { navigate(row.id) },
        title: `${row.title} · ${row.project}`,
      },
      h('span', { className: 'tc-dot', style: { background: toneOf(row) }, 'aria-hidden': true }),
      h('span', { className: 'tc-row-main' },
        h('span', { className: 'tc-row-title' }, row.title),
        h('span', { className: 'tc-row-meta' },
          h('span', { className: 'tc-row-project' }, row.project),
          row.updatedAt > 0 ? h('span', { className: 'tc-row-time' }, relativeTime(t, row.updatedAt)) : null)),
      h('span', { className: 'tc-state', style: { color: toneOf(row) } }, stateLabel(t, row)),
      h('span', { className: 'tc-chevron', 'aria-hidden': true }, '\u203a')));

      const groups = [
        ['waiting', model.waiting],
        ['running', model.running],
        ['completed', model.completed],
      ].filter(([, rows]) => rows.length > 0);

      const body = h('div', { className: 'tc-body' },
        groups.length === 0
          ? h('p', { className: 'tc-empty' }, t('panel.empty'))
          : groups.map(([group, rows]) => h('section', { key: group },
            h('h3', { className: 'tc-group' }, t(`panel.group.${group}`)),
            h('ul', { className: 'tc-rows' }, rows.map(renderRow)))));

      const reminderLine = lastReminder === undefined
        ? undefined
        : `${t('native.lastReminder')} · ${new Date(lastReminder.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · ${t(`native.channel.${lastReminder.channel}`)}`;
      const footNote = reminderLine ?? `v${VERSION}`;

      const footer = h('footer', { className: 'tc-foot' },
        h('div', { className: 'tc-foot-row' },
          h('span', { className: 'tc-foot-label', title: t('sort.hint') }, t('sort.label')),
          h('button', {
            type: 'button',
            role: 'switch',
            className: 'tc-switch',
            'aria-checked': sortOn,
            'aria-label': t('sort.label'),
            'data-on': sortOn ? '' : undefined,
            title: t('sort.hint'),
            onClick: toggleSort,
          }, h('span', { className: 'tc-switch-thumb', 'aria-hidden': true }))),
        h('div', { className: 'tc-foot-row' },
          h('span', { className: 'tc-foot-label' },
            `${t('native.label')} · ${t(`native.status.${nativeState}`)}`)),
        footNote === undefined ? null : h('p', { className: 'tc-foot-note' }, footNote));

      const panel = open && anchor !== undefined
        ? h('section', {
          ref: panelRef,
          id: 'task-center-panel',
          className: 'tc-panel',
          style: { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` },
          role: 'dialog',
          tabIndex: -1,
          'data-task-center-panel': '',
          'aria-label': t('panel.title'),
        },
        h('header', { className: 'tc-head' },
          h('div', { className: 'tc-head-row' },
            h('h2', { className: 'tc-title' }, t('panel.title')),
            h('button', {
              type: 'button', className: 'tc-close', 'aria-label': t('panel.close'), onClick: close,
            }, '\u00d7')),
          h('span', { className: 'tc-summary' }, t('panel.summary', {
            waiting: model.waiting.length,
            running: model.running.length,
            completed: model.completed.length,
          }))),
        body,
        footer)
        : null;

      return h('div', {
        ref: rootRef,
        className: 'tc-layer',
        'data-rail': rail ? '' : undefined,
        'data-task-center': '',
      },
      panel,
      h('button', {
        ref: triggerRef,
        type: 'button',
        className: 'tc-trigger',
        'data-open': open ? '' : undefined,
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        'aria-controls': open ? 'task-center-panel' : undefined,
        'aria-label': t('action.openAria', { waiting: waitingCount, running: model.running.length }),
        title: t('action.open'),
        onClick: () => { setOpen(value => !value) },
      },
      h('span', { className: 'tc-glyph', style: { position: rail ? 'relative' : 'static' } },
        h(TaskGlyph, { size: rail ? 18 : 16 }),
        rail && waitingCount > 0 ? h('span', { className: 'tc-rail-dot', 'aria-hidden': true }) : null),
      rail ? null : h('span', { className: 'tc-label' }, t('action.open')),
      rail || waitingCount === 0
        ? null
        : h('span', { className: 'tc-badge', 'aria-hidden': true }, String(waitingCount))),
      h(Styles));
    }

    /** Guarded entry: a profile without the Session sources renders nothing. */
    function FooterAction(props) {
      if (typeof props.useSessions !== 'function'
        || typeof props.useSessionStatus !== 'function'
        || typeof props.useWorkspaces !== 'function'
        || typeof props.useWorkspaceSort !== 'function'
        || typeof props.useNativePermission !== 'function'
        || typeof props.useLastReminder !== 'function') return null;
      return h(FooterActionView, props);
    }

    /* ------------------------------------------------- native reminders */

    /**
     * System notifications through the page's Notification API, which the
     * Desktop shell turns into macOS notification-center banners (it grants
     * every non-media permission to its own window). Returns false whenever a
     * banner cannot be shown, so the caller keeps its in-page fallback.
     * @param openSession - navigation action bound to a banner click.
     * @param t - translator bound to this plugin's namespace.
     */
    function createNativeNotifier(openSession, t) {
      const supported = typeof window !== 'undefined' && typeof window.Notification === 'function';
      const live = new Map();
      const listeners = new Set();
      let permission = 'unsupported';
      let warned = false;
      const setPermission = (next) => {
        if (next === permission) return;
        permission = next;
        for (const listener of [...listeners]) listener();
      };
      const permissionStore = {
        getSnapshot: () => permission,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener) };
        },
      };

      if (supported) {
        // Read the stored answer only. Asking without a user gesture can be
        // auto-denied by Chromium, and a denial is final for the page, so the
        // request happens when a reminder needs it or when the user tests.
        try {
          setPermission(window.Notification.permission);
        } catch {
          setPermission('denied');
        }
      }

      /** Drop the banner already standing for this Session before replacing it. */
      const close = (sessionId) => {
        const previous = live.get(sessionId);
        if (previous === undefined) return;
        live.delete(sessionId);
        try {
          previous.close();
        } catch {
          // A banner the OS already retired throws nothing in practice.
        }
      };

      /** Ask the system once and cache the answer; `denied` is final. */
      const requestPermission = async () => {
        if (!supported) return permission;
        if (permission === 'granted' || permission === 'denied') return permission;
        try {
          if (typeof window.Notification.requestPermission === 'function') {
            setPermission(await window.Notification.requestPermission());
          } else {
            setPermission(window.Notification.permission);
          }
        } catch {
          setPermission('denied');
        }
        return permission;
      };

      return {
        permission: permissionStore,
        requestPermission,
        /**
         * @param {{ sessionId: string, title: string, body: string }} reminder
         * @returns true when the OS showed it and the caller should stay quiet.
         */
        show(reminder) {
          if (!supported) return false;
          if (permission !== 'granted') {
            // One late request; this reminder keeps the in-page fallback.
            if (permission === 'default') void requestPermission();
            return false;
          }
          try {
            close(reminder.sessionId);
            const banner = new window.Notification(reminder.title, {
              body: reminder.body,
              tag: `task-center:${reminder.sessionId}`,
              silent: false,
            });
            banner.onclick = () => {
              live.delete(reminder.sessionId);
              try {
                window.focus();
              } catch {
                // Focus is best effort; navigation below is what matters.
              }
              openSession(reminder.sessionId);
              try {
                banner.close();
              } catch {
                // Closing an already-clicked banner is harmless.
              }
            };
            banner.onclose = () => { live.delete(reminder.sessionId) };
            live.set(reminder.sessionId, banner);
            return true;
          } catch (error) {
            if (!warned) {
              warned = true;
              console.warn('[task-center] the system notification could not be shown:', error);
            }
            return false;
          }
        },
        dispose() {
          for (const banner of live.values()) {
            try {
              banner.close();
            } catch {
              // Disposal ignores banners the OS already dropped.
            }
          }
          live.clear();
        },
      };
    }

    /* ---------------------------------------------------------- reminders */

    /**
     * `shell.overlay` occupant: a bounded stack of reminders for Sessions that
     * asked something or finished while the user was elsewhere.
     * @param props - slot props plus the injected navigation action.
     */
    function NotificationLayerView(props) {
      const { t, useSessions, useSessionStatus, useWorkspaces, openSession, showNative, recordReminder } = props;
      const list = useSessions(state => state);
      const statuses = useSessionStatus(snapshot => snapshot);
      const workspaces = useWorkspaces(snapshot => snapshot);

      const [toasts, setToasts] = useState([]);
      const previous = useRef(null);
      const timers = useRef(new Map());
      const sequence = useRef(0);

      const dismiss = useCallback((toastId) => {
        setToasts(current => (current.some(toast => toast.id === toastId)
          ? current.filter(toast => toast.id !== toastId)
          : current));
      }, []);

      /**
       * Post one reminder. The system notification is always tried first, for
       * the viewed Session as well; the in-page card is only the fallback when
       * the system refuses.
       * @param {string} reason - reminder title.
       * @param {{ id: string, title: string, project: string }} row
       * @returns {'system' | 'page'}
       */
      const deliver = (reason, row) => {
        const native = typeof showNative === 'function'
          && showNative({ sessionId: row.id, title: reason, body: `${row.title} · ${row.project}` }) === true;
        const channel = native ? 'system' : 'page';
        if (typeof recordReminder === 'function') {
          recordReminder({ time: Date.now(), channel, title: reason, session: row.title, project: row.project });
        }
        console.info(`[task-center] reminder via ${channel}: ${row.id} ${row.kind}`);
        return channel;
      };

      useEffect(() => {
        const ready = !!(list && list.phase === 'ready');
        if (!ready) {
          // A list that is still arriving would otherwise replay old state as news.
          previous.current = null;
          return;
        }
        const model = buildModel({ list, statuses, workspaces, t });

        // A Session that leaves the visible catalog keeps no bookkeeping, so the
        // map stays bounded; one that is merely idle keeps its announced asks.
        const byId = (list && list.byId) || {};
        const baseline = previous.current;
        const next = baseline ? new Map(baseline) : new Map();
        for (const id of next.keys()) if (!(id in byId)) next.delete(id);

        const additions = [];
        const added = new Set();

        for (const row of model.rows) {
          const before = baseline ? baseline.get(row.id) : undefined;
          const announced = new Set(before ? before.announced : []);
          for (const token of row.tokens) announced.add(token);
          // Bound the memory a long-lived Session can accumulate.
          if (announced.size > 32) {
            let extra = announced.size - 32;
            for (const token of announced) {
              if (extra-- <= 0) break;
              announced.delete(token);
            }
          }

          // A finish observed here counts even when DSH never marked the Session
          // unread (that flag only exists for a Session finished off-screen).
          const stoppedNow = row.kind === 'idle' && before !== undefined && before.running === true;
          const finished = row.kind === 'completed' || stoppedNow;
          next.set(row.id, {
            announced,
            running: row.kind === 'running',
            // Starting a new run clears the finish marker so the next stop notifies.
            finished: row.kind === 'running' ? false : (finished || !!(before && before.finished)),
          });
          // The first ready snapshot is the baseline, not news.
          if (!baseline) continue;

          if (row.kind === 'waiting') {
            const isNew = !before || row.tokens.some(token => !before.announced.has(token));
            if (!isNew || added.has(row.id)) continue;
            added.add(row.id);
            const reason = t(PENDING_TOAST[row.pendingKind] || 'toast.title.pending');
            const shown = deliver(reason, row);
            if (shown === 'system') continue;
            sequence.current += 1;
            additions.push({
              id: `tc-toast-${sequence.current}`,
              sessionId: row.id,
              group: 'waiting',
              pendingKind: row.pendingKind,
              title: row.title,
              project: row.project,
            });
          } else if (finished) {
            if ((before && before.finished) || added.has(row.id)) continue;
            added.add(row.id);
            const reason = t('toast.title.completed');
            const shown = deliver(reason, row);
            if (shown === 'system') continue;
            sequence.current += 1;
            additions.push({
              id: `tc-toast-${sequence.current}`,
              sessionId: row.id,
              group: 'completed',
              pendingKind: undefined,
              title: row.title,
              project: row.project,
            });
          }
        }
        previous.current = next;

        setToasts((current) => {
          const kept = current.filter((toast) => {
            const row = model.bySession.get(toast.sessionId);
            if (row === undefined) return false;
            // A waiting card dies with its question; a finished card lives until
            // its own timer, unless the Session starts working again.
            if (toast.group === 'waiting') return row.kind === 'waiting';
            return row.kind !== 'running';
          });
          if (additions.length === 0) return kept.length === current.length ? current : kept;
          const incoming = new Set(additions.map(toast => toast.sessionId));
          const merged = [...additions, ...kept.filter(toast => !incoming.has(toast.sessionId))];
          return merged.slice(0, MAX_TOASTS);
        });
      }, [list, statuses, workspaces, t, showNative, recordReminder]);

      // One bounded lifetime per reminder; cleared on dismissal and on unload.
      useEffect(() => {
        const live = new Set(toasts.map(toast => toast.id));
        for (const toast of toasts) {
          if (timers.current.has(toast.id)) continue;
          timers.current.set(toast.id, setTimeout(() => {
            timers.current.delete(toast.id);
            dismiss(toast.id);
          }, TOAST_MS));
        }
        for (const [toastId, timer] of timers.current) {
          if (live.has(toastId)) continue;
          clearTimeout(timer);
          timers.current.delete(toastId);
        }
      }, [toasts, dismiss]);

      useEffect(() => () => {
        for (const timer of timers.current.values()) clearTimeout(timer);
        timers.current.clear();
      }, []);

      const openToast = (toast) => {
        dismiss(toast.id);
        openSession(toast.sessionId);
      };

      // The live region stays mounted so that going from no reminder to one is
      // an announced change rather than a new region.
      return h('div', {
        className: 'tc-toasts',
        'data-task-center-toasts': '',
        'aria-live': 'polite',
        'aria-label': t('panel.title'),
      },
      h(Styles),
      toasts.map((toast) => {
        const tone = toast.group === 'completed' ? TONE.completed : TONE.waiting;
        const kindLabel = toast.group === 'completed'
          ? t('state.completed')
          : t(PENDING_LABEL[toast.pendingKind] || 'state.pendingOther');
        const titleLabel = toast.group === 'completed'
          ? t('toast.title.completed')
          : t(PENDING_TOAST[toast.pendingKind] || 'toast.title.pending');
        return h('div', { key: toast.id, className: 'tc-toast' },
          h('span', { className: 'tc-toast-accent', style: { background: tone }, 'aria-hidden': true }),
          h('div', { className: 'tc-toast-body' },
            h('button', {
              type: 'button',
              className: 'tc-toast-open',
              onClick: () => { openToast(toast) },
              title: `${titleLabel} · ${toast.project}`,
            },
            h('span', { className: 'tc-toast-kind', style: { color: tone } }, titleLabel),
            h('span', { className: 'tc-toast-title' }, toast.title),
            h('span', { className: 'tc-toast-project' }, `${toast.project} · ${kindLabel}`)),
            h('button', {
              type: 'button',
              className: 'tc-close',
              'aria-label': t('toast.dismiss'),
              onClick: () => { dismiss(toast.id) },
            }, '\u00d7')));
      }));
    }

    /** Guarded entry mirroring {@link FooterAction}. */
    function NotificationLayer(props) {
      if (typeof props.useSessions !== 'function'
        || typeof props.useSessionStatus !== 'function'
        || typeof props.useWorkspaces !== 'function') return null;
      return h(NotificationLayerView, props);
    }

    /* ------------------------------------------------------------- plugin */

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'task-center: zh dictionary');
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'task-center: en dictionary');

        const openSession = (sessionId) => {
          try {
            ctx.uiWorkspace.openSession(sessionId);
          } catch (error) {
            console.warn('[task-center] opening the Session failed:', error);
          }
        };
        const sortPreference = createSortPreference();
        const setWorkspaceSort = (mode) => { sortPreference.set(mode) };
        const translate = ctx.locale.bind(NS);
        const notifier = createNativeNotifier(openSession, translate);
        ctx.effect(() => () => { notifier.dispose() }, 'task-center: system notifications');
        const showNative = (reminder) => notifier.show(reminder);
        const lastReminder = createStore(undefined);
        const recordReminder = (entry) => { lastReminder.set(entry) };
        const face = () => ({
          openSession,
          setWorkspaceSort,
          showNative,
          recordReminder,
          hooks: {
            workspaceSort: sortPreference,
            nativePermission: notifier.permission,
            lastReminder,
          },
        });

        // The sidebar order is a Host-owned list: the sorter moves Workspaces
        // through the Client Controller, and nothing is written when the order
        // already matches recent activity.
        ctx.inject(['sessions', 'workspaces'], (scope) => {
          scope.effect(() => createWorkspaceSorter(scope, sortPreference), 'task-center: workspace order');
        });

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'task-center',
          locale: NS,
          inject: face,
        }, FooterAction));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'task-center.toasts',
          locale: NS,
          inject: face,
        }, NotificationLayer));
      },
    };
  },
});

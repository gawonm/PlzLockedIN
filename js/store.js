/*
 * store.js — localStorage 저장소 + 내보내기/가져오기
 * 저장 실패(사생활 보호 모드, 용량 초과 등)에도 앱은 계속 동작하고, 경고만 띄운다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FocusStore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'focusTracker.v1';
  const SCHEMA_VERSION = 1;

  function empty() {
    return { version: SCHEMA_VERSION, sessions: [], events: [], activeSessionId: null };
  }

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalize(raw) {
    const d = empty();
    if (!raw || typeof raw !== 'object') return d;
    d.sessions = Array.isArray(raw.sessions)
      ? raw.sessions.filter((s) => s && s.id && Number.isFinite(s.startAt)).map((s) => ({
          id: String(s.id),
          label: String(s.label || '집중'),
          anchorNote: String(s.anchorNote || ''),
          startAt: s.startAt,
          endAt: Number.isFinite(s.endAt) ? s.endAt : null,
        }))
      : [];
    d.events = Array.isArray(raw.events)
      ? raw.events.filter((e) => e && e.id && Number.isFinite(e.ts)).map((e) => ({
          id: String(e.id),
          sessionId: e.sessionId ? String(e.sessionId) : null,
          ts: e.ts,
          type: e.type === 'park' ? 'park' : 'return',
          category: e.category || null,
          note: String(e.note || ''),
          durationBucket: e.durationBucket || null,
          resolved: !!e.resolved,
        }))
      : [];
    const active = d.sessions.find((s) => s.id === raw.activeSessionId && s.endAt == null);
    d.activeSessionId = active ? active.id : null;
    return d;
  }

  function load(storage) {
    try {
      const txt = storage.getItem(KEY);
      return { data: txt ? normalize(JSON.parse(txt)) : empty(), ok: true };
    } catch (err) {
      return { data: empty(), ok: false, error: err };
    }
  }

  function save(storage, data) {
    try {
      storage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (err) {
      return false;
    }
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCSV(data) {
    const sessions = new Map(data.sessions.map((s) => [s.id, s]));
    const header = ['event_id', 'timestamp_iso', 'date', 'hour', 'type', 'category', 'note', 'duration_bucket', 'resolved', 'session_id', 'session_label', 'minutes_since_session_start'];
    const rows = [...data.events].sort((a, b) => a.ts - b.ts).map((e) => {
      const d = new Date(e.ts);
      const s = e.sessionId ? sessions.get(e.sessionId) : null;
      return [
        e.id, d.toISOString(),
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        d.getHours(), e.type, e.category || '', e.note, e.durationBucket || '', e.resolved,
        e.sessionId || '', s ? s.label : '', s ? ((e.ts - s.startAt) / 60000).toFixed(1) : '',
      ].map(csvCell).join(',');
    });
    return '﻿' + [header.join(','), ...rows].join('\n');
  }

  /** LLM/MCP 분석에 바로 넘기기 좋은 자기설명형 JSON */
  function toJSON(data) {
    return JSON.stringify({
      schema: 'focus-tracker',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
      glossary: {
        park: '딴생각이 떠올랐지만 따라가지 않고 적어 둠(예방)',
        return: '이미 딴짓을 다녀온 뒤 알아차림(발생)',
        durationBucket: 'm1=~1분, m5=~5분, m15=~15분, m30=30분 이상',
      },
      sessions: data.sessions,
      events: data.events,
    }, null, 2);
  }

  function fromJSON(text) {
    const raw = JSON.parse(text);
    if (!raw || !Array.isArray(raw.events) || !Array.isArray(raw.sessions)) {
      throw new Error('focus-tracker 형식의 JSON이 아닙니다.');
    }
    const d = normalize(raw);
    d.activeSessionId = null;
    return d;
  }

  return { KEY, SCHEMA_VERSION, empty, uid, normalize, load, save, toCSV, toJSON, fromJSON };
});

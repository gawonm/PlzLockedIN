/*
 * store.js — 로컬 우선 저장소 (localStorage)
 *
 *  - v2 키: focusTracker.v2   (현재 스키마)
 *  - v1 키: focusTracker.v1   (1차 데모). 마이그레이션 후에도 지우지 않고 백업으로 남겨 둔다.
 *    단, 사용자가 '전체 삭제'를 실행하면 두 키 모두 지운다(지우지 않으면 다음 로드 때 v1이 되살아남).
 *  - 저장 실패(사생활 보호 모드, 용량 초과)에도 앱은 계속 동작하고, 호출자에게 실패를 알려 준다.
 */
(function (root, factory) {
  const stats = typeof module !== 'undefined' && module.exports ? require('./stats.js') : root.FocusStats;
  const api = factory(stats);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FocusStore = api;
})(typeof self !== 'undefined' ? self : this, function (Stats) {
  'use strict';

  const KEY = 'focusTracker.v2';
  const KEY_V1 = 'focusTracker.v1';
  const SCHEMA_VERSION = 2;
  const STALE_SESSION_MS = 12 * 60 * 60 * 1000;

  const TASK_TYPES = ['class', 'coding', 'work', 'reading', 'other'];
  const ACTIVITIES = ['search', 'messenger', 'other-task', 'moving', 'other'];
  const TRIGGERS = ['thought', 'notification', 'person', 'noise', 'fatigue', 'other'];
  const RETURNED = ['yes', 'no', 'unknown'];

  function empty() {
    return { schemaVersion: SCHEMA_VERSION, activeSessionId: null, sessions: [], events: [], settings: { experiment: null }, declines: [], days: {} };
  }

  // ---------- 집중 저하 보고 · 하루 맥락 (모두 선택 입력, 민감 정보) ----------
  const SYMPTOMS = ['distracted', 'sleepy', 'lethargic', 'irritable', 'drifted'];
  const CERTAINTY = ['sure', 'estimated'];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** 집중 저하 보고. onsetFrom~onsetTo는 '흐려졌다고 느낀' 자기보고 시각(범위), recordedAt은 입력한 시각 */
  function normDecline(x) {
    if (!x || !x.id || !Number.isFinite(x.onsetFrom)) return null;
    let a = x.onsetFrom;
    let b = Number.isFinite(x.onsetTo) ? x.onsetTo : a;
    if (b < a) [a, b] = [b, a];
    const symptoms = [...new Set(Array.isArray(x.symptoms) ? x.symptoms.filter((v) => SYMPTOMS.includes(v)) : [])];
    return {
      id: String(x.id),
      eventId: x.eventId ? String(x.eventId) : null,
      onsetFrom: a,
      onsetTo: b,
      onsetCertainty: oneOf(x.onsetCertainty, CERTAINTY) || 'sure',
      symptoms,
      note: str(x.note, 300),
      tz: x.tz ? String(x.tz) : null,
      tzOffsetMin: num(x.tzOffsetMin),
      recordedAt: num(x.recordedAt) != null ? x.recordedAt : a,
      createdAt: num(x.createdAt) != null ? x.createdAt : a,
      updatedAt: num(x.updatedAt) != null ? x.updatedAt : a,
    };
  }

  /**
   * 하루 맥락. dose.status: 'taken' | 'not-taken' | null(미기록 — 복용 안 함과 다름)
   * dose.times: 복용 시각 후보(1~3개, 절대 시각 ms). 후보가 여럿이면 기억이 불확실하다는 뜻.
   * dose.multiple: 이날 여러 번 복용 → 경과시간 비교에서 제외
   */
  function normDay(x) {
    if (!x || typeof x !== 'object') return null;
    const dose = x.dose || {};
    const times = Array.isArray(dose.times) ? [...new Set(dose.times.filter((t) => Number.isFinite(t)))].sort((p, q) => p - q).slice(0, 3) : [];
    const sleep = x.sleep || {};
    const meal = x.meal || {};
    const hours = Number.isFinite(sleep.hours) && sleep.hours >= 0 && sleep.hours <= 24 ? sleep.hours : null;
    return {
      dose: {
        status: oneOf(dose.status, ['taken', 'not-taken']),
        times,
        certainty: oneOf(dose.certainty, CERTAINTY) || (times.length > 1 ? 'estimated' : 'sure'),
        multiple: !!dose.multiple,
      },
      sleep: { hours, short: typeof sleep.short === 'boolean' ? sleep.short : null },
      meal: { skipped: typeof meal.skipped === 'boolean' ? meal.skipped : null, time: num(meal.time) },
      load: oneOf(x.load, ['light', 'normal', 'high']),
      note: str(x.note, 300),
      tzOffsetMin: num(x.tzOffsetMin),
      updatedAt: num(x.updatedAt) != null ? x.updatedAt : 0,
    };
  }

  function normDeclines(list) {
    const seen = new Set();
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
      const n = normDecline(x);
      if (n && !seen.has(n.id)) { seen.add(n.id); out.push(n); }
    }
    return out.sort((p, q) => p.onsetFrom - q.onsetFrom);
  }
  function normDays(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const k of Object.keys(obj).sort()) {
      if (!DATE_RE.test(k)) continue;
      const n = normDay(obj[k]);
      if (n) out[k] = n;
    }
    return out;
  }

  /** 선택적 설정. 지금은 '다음 세션에서 해볼 실험' 하나만 둔다 */
  function normSettings(raw) {
    const out = { experiment: null };
    const x = raw && raw.experiment;
    if (x && typeof x.id === 'string' && x.id && typeof x.text === 'string') {
      out.experiment = { id: x.id.slice(0, 80), text: x.text.slice(0, 200), chosenAt: Number.isFinite(x.chosenAt) ? x.chosenAt : null };
    }
    return out;
  }

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function currentTz() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (e) {
      return null;
    }
  }

  /** 해당 시각의 로컬 UTC 오프셋(분). 한국 = +540. DST가 있는 지역은 시각마다 다를 수 있음 */
  function offsetAt(ts) {
    return -new Date(ts).getTimezoneOffset();
  }

  const oneOf = (v, list) => (list.includes(v) ? v : null);
  const str = (v, max) => (v == null ? '' : String(v)).slice(0, max || 500);
  const num = (v) => (Number.isFinite(v) ? v : null);

  function inferTaskType(label) {
    const s = String(label || '');
    if (/수업|강의|lecture|class/i.test(s)) return 'class';
    if (/코딩|개발|코드|coding|code/i.test(s)) return 'coding';
    if (/업무|회의|work/i.test(s)) return 'work';
    if (/독서|읽기|reading/i.test(s)) return 'reading';
    return s ? 'other' : null;
  }

  // ---------- 생성 ----------
  function newSession(fields, now) {
    now = now != null ? now : Date.now();
    return {
      id: uid('s'),
      taskType: oneOf(fields.taskType, TASK_TYPES),
      task: str(fields.task, 80),
      location: str(fields.location, 120),
      nextAction: str(fields.nextAction, 120),
      experimentId: fields.experimentId ? String(fields.experimentId).slice(0, 80) : null,
      startAt: now,
      endAt: null,
      endReason: null,
      tz: currentTz(),
      tzOffsetMin: offsetAt(now),
      createdAt: now,
      updatedAt: now,
    };
  }

  function newEvent(session, now) {
    now = now != null ? now : Date.now();
    return {
      id: uid('e'),
      sessionId: session ? session.id : null,
      ts: now,
      tz: currentTz(),
      tzOffsetMin: offsetAt(now),
      source: 'one-tap',
      taskType: session ? session.taskType : null,
      thought: '',
      activity: null,
      trigger: null,
      returned: 'unknown',
      note: '',
      keepForLater: false,
      laterDone: false,
      chainLink: null, // 예약 필드: 연쇄 이탈 여부를 사용자가 직접 확정할 때 사용 (자동 확정 안 함)
      createdAt: now,
      updatedAt: now,
    };
  }

  // ---------- 정규화 / 마이그레이션 ----------
  function normSession(s) {
    if (!s || !s.id || !Number.isFinite(s.startAt)) return null;
    const endAt = num(s.endAt);
    return {
      id: String(s.id),
      taskType: oneOf(s.taskType, TASK_TYPES),
      task: str(s.task, 80),
      location: str(s.location, 120),
      nextAction: str(s.nextAction, 120),
      experimentId: s.experimentId ? String(s.experimentId).slice(0, 80) : null,
      startAt: s.startAt,
      endAt,
      endReason: endAt == null ? null : oneOf(s.endReason, ['manual', 'stale-closed']) || 'manual',
      tz: s.tz ? String(s.tz) : null,
      tzOffsetMin: num(s.tzOffsetMin),
      createdAt: num(s.createdAt) != null ? s.createdAt : s.startAt,
      updatedAt: num(s.updatedAt) != null ? s.updatedAt : s.startAt,
    };
  }

  function normEvent(e) {
    if (!e || !e.id || !Number.isFinite(e.ts)) return null;
    const out = {
      id: String(e.id),
      sessionId: e.sessionId ? String(e.sessionId) : null,
      ts: e.ts,
      tz: e.tz ? String(e.tz) : null,
      tzOffsetMin: num(e.tzOffsetMin),
      source: oneOf(e.source, ['one-tap', 'migrated']) || 'one-tap',
      taskType: oneOf(e.taskType, TASK_TYPES),
      thought: str(e.thought, 200),
      activity: oneOf(e.activity, ACTIVITIES),
      trigger: oneOf(e.trigger, TRIGGERS),
      returned: oneOf(e.returned, RETURNED) || 'unknown',
      note: str(e.note, 500),
      keepForLater: !!e.keepForLater,
      laterDone: !!e.laterDone,
      chainLink: e.chainLink == null ? null : e.chainLink,
      createdAt: num(e.createdAt) != null ? e.createdAt : e.ts,
      updatedAt: num(e.updatedAt) != null ? e.updatedAt : e.ts,
    };
    if (e.legacy && typeof e.legacy === 'object') {
      out.legacy = {
        type: e.legacy.type || null,
        category: e.legacy.category || null,
        durationBucket: e.legacy.durationBucket || null,
      };
    }
    return out;
  }

  function isV1(raw) {
    if (!raw || typeof raw !== 'object') return false;
    if (raw.schemaVersion >= 2) return false;
    if (raw.version === 1 || raw.schemaVersion === 1) return true;
    return Array.isArray(raw.events) && raw.events.some((e) => e && (e.type === 'park' || e.type === 'return'));
  }

  const V1_CATEGORY_MAP = {
    curious: { activity: 'search' },
    social: { activity: 'messenger' },
    tool: { activity: 'other-task' },
    todo: { trigger: 'thought' },
    mind: { trigger: 'thought' },
    body: { trigger: 'fatigue' },
    etc: {},
  };

  /** v1 → v2. 원본 정보는 legacy에 보존하여 손실 없음 */
  function migrateV1(raw) {
    const d = empty();
    const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    const types = new Map();
    for (const s of sessions) {
      if (!s || !s.id || !Number.isFinite(s.startAt)) continue;
      const taskType = inferTaskType(s.label);
      types.set(String(s.id), taskType);
      d.sessions.push(normSession({
        id: s.id, taskType, task: s.label || '', location: s.anchorNote || '', nextAction: '',
        startAt: s.startAt, endAt: s.endAt, endReason: Number.isFinite(s.endAt) ? 'manual' : null,
        tz: null, tzOffsetMin: null, createdAt: s.startAt, updatedAt: s.endAt || s.startAt,
      }));
    }
    for (const e of Array.isArray(raw.events) ? raw.events : []) {
      if (!e || !e.id || !Number.isFinite(e.ts)) continue;
      const isPark = e.type === 'park';
      const map = V1_CATEGORY_MAP[e.category] || {};
      d.events.push(normEvent({
        id: e.id,
        sessionId: e.sessionId || null,
        ts: e.ts,
        tz: null,
        tzOffsetMin: null,
        source: 'migrated',
        taskType: e.sessionId ? types.get(String(e.sessionId)) || null : null,
        thought: isPark ? e.note || '' : '',
        note: isPark ? '' : e.note || '',
        activity: map.activity || null,
        trigger: map.trigger || null,
        returned: 'unknown',
        keepForLater: isPark,
        laterDone: isPark && !!e.resolved,
        legacy: { type: e.type || null, category: e.category || null, durationBucket: e.durationBucket || null },
        createdAt: e.ts,
        updatedAt: e.ts,
      }));
    }
    const active = d.sessions.find((s) => s.id === raw.activeSessionId && s.endAt == null);
    d.activeSessionId = active ? active.id : null;
    return d;
  }

  function normalize(raw) {
    if (isV1(raw)) return migrateV1(raw);
    const d = empty();
    if (!raw || typeof raw !== 'object') return d;
    const seenS = new Set();
    for (const s of Array.isArray(raw.sessions) ? raw.sessions : []) {
      const n = normSession(s);
      if (n && !seenS.has(n.id)) { seenS.add(n.id); d.sessions.push(n); }
    }
    const seenE = new Set();
    for (const e of Array.isArray(raw.events) ? raw.events : []) {
      const n = normEvent(e);
      if (n && !seenE.has(n.id)) { seenE.add(n.id); d.events.push(n); }
    }
    const active = d.sessions.find((s) => s.id === raw.activeSessionId && s.endAt == null);
    d.activeSessionId = active ? active.id : null;
    d.settings = normSettings(raw.settings);
    d.declines = normDeclines(raw.declines);
    d.days = normDays(raw.days);
    // 활성 세션이 아닌데 endAt이 없는 세션은 종료 시각을 알 수 없으므로 신뢰 불가로 닫음
    for (const s of d.sessions) {
      if (s.endAt == null && s.id !== d.activeSessionId) {
        s.endAt = s.startAt;
        s.endReason = 'stale-closed';
      }
    }
    return d;
  }

  /**
   * 오래 열려 있던 세션(종료를 잊은 경우)을 닫는다.
   * 종료 시각을 모르므로 마지막 기록 시각(없으면 시작 시각)으로 닫고, 'stale-closed'로 표시해
   * 시간당 비율 계산에서 제외한다.
   */
  function closeStaleSessions(data, now) {
    now = now != null ? now : Date.now();
    const s = data.activeSessionId ? data.sessions.find((x) => x.id === data.activeSessionId) : null;
    if (!s || now - s.startAt < STALE_SESSION_MS) return null;
    const evs = data.events.filter((e) => e.sessionId === s.id);
    s.endAt = evs.length ? Math.max(...evs.map((e) => e.ts)) : s.startAt;
    s.endReason = 'stale-closed';
    s.updatedAt = now;
    data.activeSessionId = null;
    return s;
  }

  // ---------- 읽기 / 쓰기 ----------
  const CORRUPT_PREFIX = 'focusTracker.corrupt.';

  /**
   * 저장된 원문을 해석한다. 읽을 수 없으면 '빈 데이터'로 간주하지 않고 corrupt로 보고한다.
   * @returns {{data, ok, migratedFromV1, dropped, corrupt?, unavailable?, error?}}
   *  - corrupt: { key, raw, reason: 'parse'|'shape', blocksWrites }
   *    blocksWrites=true(v2 손상)면 호출자는 사용자가 결정하기 전까지 v2 키에 쓰면 안 된다.
   *  - v2가 있으면 v2만 읽는다(v1을 다시 마이그레이션하지 않음). v1 키는 지우지 않는다.
   */
  function load(storage) {
    let v2;
    let v1;
    try {
      v2 = storage.getItem(KEY);
      v1 = v2 ? null : storage.getItem(KEY_V1);
    } catch (err) {
      return { data: empty(), ok: false, unavailable: true, migratedFromV1: false, dropped: 0, error: err };
    }
    const text = v2 || v1;
    const key = v2 ? KEY : KEY_V1;
    if (!text) return { data: empty(), ok: true, migratedFromV1: false, dropped: 0 };
    const corrupt = (reason, error) => ({
      data: empty(), ok: false, migratedFromV1: false, dropped: 0, error,
      corrupt: { key, raw: text, reason, blocksWrites: key === KEY },
    });
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return corrupt('parse', err);
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events) || !Array.isArray(raw.sessions)) return corrupt('shape');
    const data = v2 ? normalize(raw) : migrateV1(raw);
    const dropped = Math.max(0, raw.events.length - data.events.length) + Math.max(0, raw.sessions.length - data.sessions.length);
    return { data, ok: true, migratedFromV1: !v2, dropped };
  }

  /** 손상(또는 일부 버려질) 원문을 별도 키에 보관. 실패하면 null */
  function quarantine(storage, raw, now) {
    const k = CORRUPT_PREFIX + (now != null ? now : Date.now());
    try {
      storage.setItem(k, raw);
      return k;
    } catch (err) {
      return null;
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

  function clearAll(storage) {
    try {
      storage.removeItem(KEY);
      storage.removeItem(KEY_V1);
      return true;
    } catch (err) {
      return false;
    }
  }

  // ---------- 가져오기 ----------
  /** 내보낸 JSON(v1/v2), 혹은 원시 저장 형식을 검증·정규화 */
  function parseImport(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error('JSON 형식이 올바르지 않아요.');
    }
    if (!raw || !Array.isArray(raw.events) || !Array.isArray(raw.sessions)) {
      throw new Error('집중 트래커에서 내보낸 파일이 아니에요(events/sessions 없음).');
    }
    const d = normalize(raw);
    d.activeSessionId = null;
    for (const s of d.sessions) if (s.endAt == null) { s.endAt = s.startAt; s.endReason = 'stale-closed'; }
    const dropped = raw.events.length - d.events.length;
    return { data: d, dropped: Math.max(0, dropped) };
  }

  /** 날짜 키 기준 병합. 같은 날짜면 updatedAt이 더 최신인 쪽 */
  function mergeDays(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) if (!out[k] || (v.updatedAt || 0) > (out[k].updatedAt || 0)) out[k] = v;
    return out;
  }

  /** id 기준 병합. 같은 id면 updatedAt이 더 최신인 쪽을 유지 */
  function merge(base, incoming) {
    const pick = (a, b) => {
      const m = new Map(a.map((x) => [x.id, x]));
      let added = 0;
      let updated = 0;
      for (const x of b) {
        const cur = m.get(x.id);
        if (!cur) { m.set(x.id, x); added++; }
        else if ((x.updatedAt || 0) > (cur.updatedAt || 0)) { m.set(x.id, x); updated++; }
      }
      return { list: [...m.values()], added, updated };
    };
    const s = pick(base.sessions, incoming.sessions);
    const e = pick(base.events, incoming.events);
    return {
      data: {
        schemaVersion: SCHEMA_VERSION, activeSessionId: base.activeSessionId, sessions: s.list, events: e.list.sort((a, b) => a.ts - b.ts),
        settings: normSettings(base.settings),
        declines: pick(base.declines || [], incoming.declines || []).list.sort((p, q) => p.onsetFrom - q.onsetFrom),
        days: mergeDays(base.days || {}, incoming.days || {}),
      },
      addedEvents: e.added, updatedEvents: e.updated, addedSessions: s.added,
    };
  }

  // ---------- 내보내기 ----------
  function pad(n) { return String(n).padStart(2, '0'); }

  /** 기록 당시 오프셋 기준 로컬 ISO(+09:00). 오프셋을 모르면(v1) 현재 런타임 기준 */
  function localIso(ts, offsetMin) {
    const off = offsetMin != null ? offsetMin : offsetAt(ts);
    const d = new Date(ts + off * 60000);
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCSV(data) {
    const sessions = new Map(data.sessions.map((s) => [s.id, s]));
    const gaps = Stats.eventGaps(data.events);
    const header = [
      'event_id', 'recorded_at_local', 'recorded_at_utc', 'tz', 'date_local', 'hour_local', 'weekday_local',
      'session_id', 'session_task_type', 'session_task', 'minutes_since_session_start', 'gap_from_prev_in_group_sec',
      'task_type', 'thought', 'activity', 'trigger', 'returned', 'note', 'keep_for_later', 'later_done',
      'source', 'legacy_type', 'legacy_category', 'legacy_duration_bucket_self_report', 'created_at', 'updated_at',
    ];
    const rows = [...data.events].sort((a, b) => a.ts - b.ts).map((e) => {
      const d = new Date(e.ts);
      const s = e.sessionId ? sessions.get(e.sessionId) : null;
      const g = gaps.get(e.id);
      const L = e.legacy || {};
      return [
        e.id, localIso(e.ts, e.tzOffsetMin), d.toISOString(), e.tz || '',
        Stats.dateKey(e.ts), d.getHours(), Stats.WEEKDAYS[d.getDay()],
        e.sessionId || '', s ? s.taskType || '' : '', s ? s.task : '',
        s ? ((e.ts - s.startAt) / 60000).toFixed(1) : '', g == null ? '' : Math.round(g / 1000),
        e.taskType || '', e.thought, e.activity || '', e.trigger || '', e.returned, e.note, e.keepForLater, e.laterDone,
        e.source, L.type || '', L.category || '', L.durationBucket || '',
        new Date(e.createdAt).toISOString(), new Date(e.updatedAt).toISOString(),
      ].map(csvCell).join(',');
    });
    return '﻿' + [header.join(','), ...rows].join('\n');
  }

  /** 자기설명형 JSON (후속 분석·LLM 입력에 적합) */
  function toJSON(data, opts) {
    const includeSensitive = !opts || opts.includeSensitive !== false;
    const sensitive = includeSensitive
      ? { declines: data.declines || [], days: data.days || {} }
      : { sensitiveExcluded: true };
    return JSON.stringify({
      schema: 'focus-tracker',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      exportTz: currentTz(),
      notes: [
        'events는 사용자가 주의 이탈을 "알아차리고 기록한" 시점이다. 자동 감지된 이탈이 아니며, 기록되지 않은 이탈이 존재할 수 있다.',
        '이탈 지속시간은 관측하지 않았다. legacy.durationBucket은 1차 버전의 자기보고 값이다.',
        'returned=unknown은 복귀 여부를 기록하지 않았다는 뜻이다.',
        'endReason=stale-closed 세션은 종료 시각을 알 수 없어 시간당 비율 계산에서 제외된다.',
        'chainLink는 예약 필드이며 자동으로 확정하지 않는다.',
        'declines는 사용자가 "집중이 흐려졌다"고 직접 남긴 자기보고이며, events(아차 기록)를 자동 분류한 것이 아니다.',
        'days[날짜].dose.status=null은 미기록(복용 안 함과 다름). dose.times가 여럿이면 기억이 불확실한 후보 시각이다.',
        '이 데이터는 진단이나 복용 조언의 근거가 아니다.',
      ],
      settings: data.settings || { experiment: null },
      sessions: data.sessions,
      events: data.events,
      ...sensitive,
    }, null, 2);
  }

  return {
    KEY, KEY_V1, SCHEMA_VERSION, STALE_SESSION_MS, TASK_TYPES, ACTIVITIES, TRIGGERS, RETURNED,
    empty, uid, currentTz, offsetAt, inferTaskType, newSession, newEvent,
    SYMPTOMS, CERTAINTY, normDecline, normDay, mergeDays,
    CORRUPT_PREFIX, normalize, normSettings, migrateV1, isV1, closeStaleSessions, load, quarantine, save, clearAll,
    parseImport, merge, localIso, toCSV, toJSON,
  };
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Store = require('../js/store.js');

const at = (y, m, d, h, mi = 0) => new Date(y, m, d, h, mi).getTime();

function memStorage(init = {}) {
  const m = { ...init };
  return {
    _m: m,
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
  };
}

// 1차 데모(v1)가 실제로 저장하던 형식
const V1 = {
  version: 1,
  activeSessionId: 's-open',
  sessions: [
    { id: 's1', label: '데이터베이스 수업', anchorNote: '슬라이드 12', startAt: at(2026, 10, 2, 9), endAt: at(2026, 10, 2, 10) },
    { id: 's-open', label: '코딩', anchorNote: '', startAt: at(2026, 10, 2, 20), endAt: null },
  ],
  events: [
    { id: 'e1', sessionId: 's1', ts: at(2026, 10, 2, 9, 10), type: 'return', category: 'curious', note: '영어 단어 검색', durationBucket: 'm5', resolved: false },
    { id: 'e2', sessionId: 's1', ts: at(2026, 10, 2, 9, 30), type: 'park', category: 'tool', note: 'VS Code 노션 익스텐션', durationBucket: null, resolved: true },
    { id: 'e3', sessionId: null, ts: at(2026, 10, 3, 22), type: 'return', category: null, note: '', durationBucket: null, resolved: false },
  ],
};

test('v1 → v2 마이그레이션: 건수·시각·메모 무손실, 원본은 legacy에 보존', () => {
  const d = Store.migrateV1(V1);
  assert.equal(d.schemaVersion, 2);
  assert.equal(d.events.length, 3);
  assert.equal(d.sessions.length, 2);
  const [e1, e2, e3] = d.events;
  assert.equal(e1.ts, V1.events[0].ts);
  assert.equal(e1.activity, 'search');
  assert.equal(e1.note, '영어 단어 검색');
  assert.equal(e1.returned, 'unknown');
  assert.deepEqual(e1.legacy, { type: 'return', category: 'curious', durationBucket: 'm5' });
  assert.equal(e1.taskType, 'class');
  assert.equal(e2.thought, 'VS Code 노션 익스텐션');
  assert.equal(e2.keepForLater, true);
  assert.equal(e2.laterDone, true);
  assert.equal(e2.activity, 'other-task');
  assert.equal(e3.sessionId, null);
  assert.equal(e3.tz, null); // v1에는 타임존 정보가 없었음 → 모름
  assert.equal(d.sessions[0].task, '데이터베이스 수업');
  assert.equal(d.sessions[0].location, '슬라이드 12');
  assert.equal(d.sessions[0].endReason, 'manual');
  assert.equal(d.activeSessionId, 's-open');
  assert.ok(d.events.every((e) => e.source === 'migrated'));
});

test('load: v2가 없으면 v1을 변환하고, v1 키는 지우지 않음', () => {
  const st = memStorage({ 'focusTracker.v1': JSON.stringify(V1) });
  const r = Store.load(st);
  assert.equal(r.ok, true);
  assert.equal(r.migratedFromV1, true);
  assert.equal(r.data.events.length, 3);
  assert.ok(Store.save(st, r.data));
  assert.ok(st.getItem('focusTracker.v1'), 'v1 백업 유지');
  // 다시 로드하면 v2를 읽고 재변환하지 않음
  r.data.events.pop();
  Store.save(st, r.data);
  const r2 = Store.load(st);
  assert.equal(r2.migratedFromV1, false);
  assert.equal(r2.data.events.length, 2);
});

test('clearAll: v1·v2 모두 삭제 → 삭제한 데이터가 되살아나지 않음', () => {
  const st = memStorage({ 'focusTracker.v1': JSON.stringify(V1), 'focusTracker.v2': JSON.stringify(Store.migrateV1(V1)) });
  assert.ok(Store.clearAll(st));
  assert.equal(Store.load(st).data.events.length, 0);
});

test('저장소 오류에도 죽지 않음', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('x'); } };
  const r = Store.load(broken);
  assert.equal(r.ok, false);
  assert.equal(r.data.events.length, 0);
  assert.equal(Store.save(broken, r.data), false);
  assert.equal(Store.clearAll(broken), false);
});

test('newEvent: 타임존·세션·생성/수정 시각 자동 기록, 상세는 비어 있음', () => {
  const s = Store.newSession({ taskType: 'class', task: 'LangGraph 수업', location: 'Router 노드', nextAction: '코드 마지막 줄 확인' }, at(2026, 10, 2, 14));
  const e = Store.newEvent(s, at(2026, 10, 2, 14, 10));
  assert.equal(e.sessionId, s.id);
  assert.equal(e.taskType, 'class');
  assert.equal(e.returned, 'unknown');
  assert.equal(e.chainLink, null);
  assert.equal(e.tzOffsetMin, -new Date(e.ts).getTimezoneOffset());
  assert.ok('tz' in e);
  assert.equal(e.createdAt, e.ts);
  assert.equal(e.thought, '');
  assert.equal(e.activity, null);
  assert.ok(!('duration' in e) && !('durationBucket' in e), '지속시간 필드 없음');
});

test('normalize: 잘못된 값 정리, 중복 id 제거, 열린 비활성 세션은 stale로 닫음', () => {
  const n = Store.normalize({
    schemaVersion: 2,
    activeSessionId: 'nope',
    sessions: [{ id: 'a', startAt: 100, endAt: null }, { id: 'bad' }],
    events: [
      { id: 'x', ts: 1, activity: 'hacking', returned: 'maybe' },
      { id: 'x', ts: 2 },
      { id: 'y' },
    ],
  });
  assert.equal(n.sessions.length, 1);
  assert.equal(n.sessions[0].endReason, 'stale-closed');
  assert.equal(n.events.length, 1);
  assert.equal(n.events[0].activity, null);
  assert.equal(n.events[0].returned, 'unknown');
  assert.equal(n.activeSessionId, null);
});

test('closeStaleSessions: 12시간 넘게 열린 세션은 마지막 기록 시각으로 닫고 신뢰 불가 표시', () => {
  const d = Store.migrateV1(V1);
  const open = d.sessions.find((s) => s.id === 's-open');
  d.events.push({ ...Store.newEvent(open, open.startAt + 30 * 60000) });
  assert.equal(Store.closeStaleSessions(d, open.startAt + 60 * 60000), null, '1시간 뒤엔 유지');
  const closed = Store.closeStaleSessions(d, open.startAt + 13 * 3600000);
  assert.equal(closed.id, 's-open');
  assert.equal(closed.endAt, open.startAt + 30 * 60000);
  assert.equal(closed.endReason, 'stale-closed');
  assert.equal(d.activeSessionId, null);
});

test('parseImport: v1·v2 내보내기 모두 허용, 형식 오류는 명확한 에러', () => {
  const fromV1 = Store.parseImport(JSON.stringify(V1));
  assert.equal(fromV1.data.events.length, 3);
  assert.equal(fromV1.data.activeSessionId, null);
  assert.ok(fromV1.data.sessions.every((s) => s.endAt != null));
  const exported = Store.toJSON(fromV1.data);
  const back = Store.parseImport(exported);
  assert.deepEqual(back.data.events, fromV1.data.events);
  assert.throws(() => Store.parseImport('{not json'), /JSON/);
  assert.throws(() => Store.parseImport('{"foo":1}'), /events/);
});

test('merge: id 기준, 더 최근 updatedAt 우선', () => {
  const a = Store.migrateV1(V1);
  const b = JSON.parse(JSON.stringify(a));
  b.events[0].note = '수정됨';
  b.events[0].updatedAt += 1000;
  b.events[1].note = '오래된 값';
  b.events[1].updatedAt -= 1000;
  b.events.push({ ...b.events[2], id: 'new-1' });
  const r = Store.merge(a, b);
  assert.equal(r.addedEvents, 1);
  assert.equal(r.updatedEvents, 1);
  assert.equal(r.data.events.length, 4);
  assert.equal(r.data.events.find((e) => e.id === 'e1').note, '수정됨');
  assert.notEqual(r.data.events.find((e) => e.id === 'e2').note, '오래된 값');
});

test('CSV: 이스케이프, 그룹 내 간격, 로컬 ISO 오프셋', () => {
  const d = Store.migrateV1(V1);
  d.events[0].note = 'VS Code, "노션"\n익스텐션';
  const csv = Store.toCSV(d);
  const lines = csv.replace('﻿', '').split('\n');
  const header = lines[0].split(',');
  assert.equal(header[0], 'event_id');
  assert.ok(header.includes('gap_from_prev_in_group_sec'));
  assert.ok(csv.includes('"VS Code, ""노션""\n익스텐션"'));
  const gi = header.indexOf('gap_from_prev_in_group_sec');
  const e2row = lines.find((l) => l.startsWith('e2,')).split(',');
  assert.equal(e2row[gi], '1200'); // 9:10 → 9:30
  assert.match(Store.localIso(Date.UTC(2026, 0, 1, 0, 0), 540), /^2026-01-01T09:00:00\+09:00$/);
  assert.match(Store.localIso(Date.UTC(2026, 0, 1, 0, 0), -300), /^2025-12-31T19:00:00-05:00$/);
});

// ───────── 저장 안정성 (디자인 인수인계 §5) ─────────
test('손상 데이터: 파싱 오류 시 corrupt로 보고하고 원본을 돌려줌(빈 상태로 간주하지 않음)', () => {
  const st = memStorage({ 'focusTracker.v2': '{"events":[{"id":"a"' });
  const r = Store.load(st);
  assert.equal(r.ok, false);
  assert.ok(r.corrupt);
  assert.equal(r.corrupt.key, 'focusTracker.v2');
  assert.equal(r.corrupt.raw, '{"events":[{"id":"a"');
  assert.equal(r.corrupt.blocksWrites, true);
  assert.equal(st.getItem('focusTracker.v2'), '{"events":[{"id":"a"', 'load가 원본을 바꾸지 않음');
});

test('손상 데이터: JSON은 맞지만 형식이 다르면 corrupt', () => {
  const r = Store.load(memStorage({ 'focusTracker.v2': '{"hello":1}' }));
  assert.ok(r.corrupt);
  assert.equal(r.corrupt.reason, 'shape');
});

test('손상 v1은 v2 쓰기를 막지 않지만 원본은 보고함', () => {
  const r = Store.load(memStorage({ 'focusTracker.v1': 'not json' }));
  assert.ok(r.corrupt);
  assert.equal(r.corrupt.key, 'focusTracker.v1');
  assert.equal(r.corrupt.blocksWrites, false);
});

test('quarantine: 손상 원본을 별도 키에 보관', () => {
  const st = memStorage({ 'focusTracker.v2': '{broken' });
  const k = Store.quarantine(st, '{broken', 1234);
  assert.equal(k, 'focusTracker.corrupt.1234');
  assert.equal(st.getItem(k), '{broken');
  assert.equal(st.getItem('focusTracker.v2'), '{broken');
});

test('일부 항목이 잘못된 경우 dropped 개수를 알려 줌', () => {
  const raw = { schemaVersion: 2, sessions: [], events: [{ id: 'a', ts: 1 }, { id: 'b' }, { nope: 1 }] };
  const r = Store.load(memStorage({ 'focusTracker.v2': JSON.stringify(raw) }));
  assert.equal(r.ok, true);
  assert.equal(r.data.events.length, 1);
  assert.equal(r.dropped, 2);
});

test('설정(선택한 실험)과 세션 experimentId 보존, 병합 시 기존 설정 유지', () => {
  const d = Store.normalize({
    schemaVersion: 2, sessions: [{ id: 's', startAt: 1, endAt: 2, endReason: 'manual', experimentId: 'top-activity:search' }], events: [],
    settings: { experiment: { id: 'top-activity:search', text: '검색어 맡기기', chosenAt: 5 } },
  });
  assert.equal(d.sessions[0].experimentId, 'top-activity:search');
  assert.deepEqual(d.settings.experiment, { id: 'top-activity:search', text: '검색어 맡기기', chosenAt: 5 });
  const back = Store.parseImport(Store.toJSON(d)).data;
  assert.deepEqual(back.settings, d.settings);
  const m = Store.merge(d, Store.empty()).data;
  assert.deepEqual(m.settings, d.settings);
  assert.deepEqual(Store.empty().settings, { experiment: null });
  assert.equal(Store.normalize({ schemaVersion: 2, sessions: [], events: [], settings: { experiment: { id: 5 } } }).settings.experiment, null);
});

// ───────── 집중 저하·하루 맥락 (FOCUS_DECLINE_PATTERN_PROPOSAL) ─────────
test('집중 저하·하루 맥락: 선택 필드 정규화(검증·불확실성·미기록 구분)', () => {
  const d = Store.normalize({
    schemaVersion: 2, sessions: [], events: [],
    declines: [
      { id: 'd1', eventId: 'e1', onsetFrom: at(2026, 10, 2, 17), onsetTo: at(2026, 10, 2, 16, 30), onsetCertainty: 'estimated', symptoms: ['sleepy', 'hack', 'sleepy'], recordedAt: at(2026, 10, 2, 17, 5) },
      { id: 'bad', onsetFrom: 'x' },
    ],
    days: {
      '2026-11-02': { dose: { status: 'taken', times: [at(2026, 10, 2, 8, 30), at(2026, 10, 2, 7, 30), 'x'], certainty: 'estimated' }, sleep: { hours: 99, short: true }, load: 'heavy' },
      '2026-11-03': { dose: { status: 'not-taken' } },
      'nope': { dose: { status: 'taken' } },
    },
  });
  assert.equal(d.declines.length, 1);
  const x = d.declines[0];
  assert.equal(x.onsetFrom, at(2026, 10, 2, 16, 30), '역순 범위는 정렬');
  assert.equal(x.onsetTo, at(2026, 10, 2, 17));
  assert.deepEqual(x.symptoms, ['sleepy']);
  assert.equal(x.onsetCertainty, 'estimated');
  assert.deepEqual(Object.keys(d.days), ['2026-11-02', '2026-11-03']);
  const day = d.days['2026-11-02'];
  assert.deepEqual(day.dose.times, [at(2026, 10, 2, 7, 30), at(2026, 10, 2, 8, 30)], '후보 시각 정렬, 잘못된 값 제거');
  assert.equal(day.sleep.hours, null, '범위 밖 수면 시간은 버림');
  assert.equal(day.sleep.short, true);
  assert.equal(day.load, null);
  assert.equal(d.days['2026-11-03'].dose.status, 'not-taken');
  assert.deepEqual(Store.empty().declines, []);
  assert.deepEqual(Store.empty().days, {});
  const noDose = Store.normalize({ schemaVersion: 2, sessions: [], events: [], days: { '2026-11-04': { load: 'high' } } });
  assert.equal(noDose.days['2026-11-04'].dose.status, null, '복용 미기록은 null(복용 안 함과 구분)');
});

test('집중 저하·하루 맥락: 내보내기/가져오기 왕복, 민감 항목 제외 옵션, 병합', () => {
  const base = Store.normalize({
    schemaVersion: 2, sessions: [], events: [],
    declines: [{ id: 'd1', onsetFrom: 10, onsetTo: 10, updatedAt: 5 }],
    days: { '2026-11-02': { dose: { status: 'taken', times: [1] }, updatedAt: 5 } },
  });
  const back = Store.parseImport(Store.toJSON(base)).data;
  assert.deepEqual(back.declines, base.declines);
  assert.deepEqual(back.days, base.days);
  const lean = JSON.parse(Store.toJSON(base, { includeSensitive: false }));
  assert.ok(!('declines' in lean) && !('days' in lean), '민감 항목 제외');
  assert.equal(lean.sensitiveExcluded, true);
  // 과거 백업(민감 항목 없음)을 병합해도 기존 기록 유지
  const old = Store.parseImport(JSON.stringify({ schemaVersion: 2, sessions: [], events: [] })).data;
  const m = Store.merge(base, old).data;
  assert.equal(m.declines.length, 1);
  assert.ok(m.days['2026-11-02']);
  // 같은 날짜는 더 최근 updatedAt 우선
  const newer = Store.normalize({ schemaVersion: 2, sessions: [], events: [], declines: [{ id: 'd2', onsetFrom: 20, onsetTo: 20 }], days: { '2026-11-02': { dose: { status: 'not-taken' }, updatedAt: 9 } } });
  const m2 = Store.merge(base, newer).data;
  assert.equal(m2.days['2026-11-02'].dose.status, 'not-taken');
  assert.equal(m2.declines.length, 2);
});

test('민감 항목이 없는 v2 데이터·v1 데이터와 호환', () => {
  const d = Store.migrateV1(V1);
  assert.deepEqual(d.declines, []);
  assert.deepEqual(d.days, {});
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../js/stats.js');
const Store = require('../js/store.js');

const MIN = 60 * 1000;
const at = (y, m, d, h, mi = 0) => new Date(y, m, d, h, mi).getTime();

function sample() {
  const s1 = { id: 's1', label: '수업', anchorNote: '', startAt: at(2026, 10, 2, 9), endAt: at(2026, 10, 2, 11) };
  const ev = (id, sessionId, ts, type, category = null, durationBucket = null) =>
    ({ id, sessionId, ts, type, category, note: '', durationBucket, resolved: false });
  return {
    version: 1,
    sessions: [s1],
    events: [
      ev('e1', 's1', at(2026, 10, 2, 9, 10), 'return', 'curious', 'm5'),
      ev('e2', 's1', at(2026, 10, 2, 9, 30), 'park', 'curious'),
      ev('e3', 's1', at(2026, 10, 2, 10, 0), 'return', 'tool', 'm15'),
      ev('e4', null, at(2026, 10, 3, 22, 0), 'park', null),
    ],
  };
}

test('focusSpans: 세션 시작→첫 흔들림, 흔들림 간 간격 (마지막→종료 구간 제외)', () => {
  assert.deepEqual(S.focusSpans(sample()).map((x) => x / MIN), [10, 20, 30]);
  assert.equal(S.median([10, 20, 30]), 20);
  assert.equal(S.median([1, 2, 3, 4]), 2.5);
});

test('firstDriftTimes', () => {
  assert.deepEqual(S.firstDriftTimes(sample()).map((x) => x / MIN), [10]);
});

test('monthHourMatrix: 날짜×시간 집계', () => {
  const mx = S.monthHourMatrix(sample().events, 2026, 10);
  assert.equal(mx.length, 30); // 11월 = 30일
  assert.equal(mx[1][9], 2);
  assert.equal(mx[1][10], 1);
  assert.equal(mx[2][22], 1);
  assert.equal(mx.flat().reduce((a, b) => a + b, 0), 4);
});

test('dailySummary: 세션 1시간당 흔들림으로 레벨 결정', () => {
  const days = S.dailySummary(sample());
  const d2 = days['2026-11-02'];
  assert.equal(d2.count, 3);
  assert.equal(d2.focusMs, 120 * MIN);
  assert.equal(d2.rate, 1.5);
  assert.equal(d2.level, 2);
  assert.equal(days['2026-11-03'].level, 2); // 세션 없는 날: 횟수 기준
});

test('focusMsByDay: 자정을 넘는 세션 분배', () => {
  const s = { id: 'x', startAt: at(2026, 0, 1, 23), endAt: at(2026, 0, 2, 1) };
  const r = S.focusMsByDay([s]);
  assert.equal(r['2026-01-01'], 60 * MIN);
  assert.equal(r['2026-01-02'], 60 * MIN);
});

test('readiness: 20건 & 3일 이상이면 리포트 활성화', () => {
  assert.equal(S.readiness(sample()).ready, false);
  const demo = S.generateDemoData(at(2026, 10, 2, 12), 21);
  assert.equal(S.readiness(demo).ready, true);
});

test('buildReport: 지표와 규칙 기반 인사이트', () => {
  const r = S.buildReport(sample(), at(2026, 10, 4, 0));
  assert.equal(r.total, 4);
  assert.equal(r.parks, 2);
  assert.equal(r.parkRate, 0.5);
  assert.equal(r.medianSpanMs, 20 * MIN);
  assert.equal(r.ratePerHour, 1.5); // 세션 내 3건 / 2시간
  assert.equal(r.lostMinutesEstimate, 20);
  assert.equal(r.categories[0].id, 'curious');
  const ids = r.insights.map((i) => i.id);
  assert.ok(ids.includes('top-category')); // 궁금증 2/3 ≥ 40%
  assert.ok(ids.includes('first-drift')); // 첫 흔들림 10분 < 15분
  assert.ok(ids.includes('span'));
});

test('insights: 주차 성공률 낮으면 경고', () => {
  const base = { parkRate: 0.1, total: 10, categories: [], medianFirstDriftMs: null, medianSpanMs: null, worstHours: [], bestHours: [], avgReturnMinutes: null, uncategorized: 0 };
  assert.ok(S.insights(base).some((i) => i.id === 'park-low' && i.tone === 'warn'));
  assert.ok(S.insights({ ...base, parkRate: 0.7 }).some((i) => i.id === 'park-high'));
});

test('generateDemoData: 결정적(seed 고정)', () => {
  const now = at(2026, 10, 2, 12);
  assert.deepEqual(S.generateDemoData(now), S.generateDemoData(now));
});

test('store: JSON 왕복, CSV 이스케이프, 잘못된 입력 정리', () => {
  const d = { ...sample(), activeSessionId: null };
  d.events[0].note = 'VS Code, "노션"\n익스텐션';
  const back = Store.fromJSON(Store.toJSON(d));
  assert.deepEqual(back.events, d.events);
  assert.deepEqual(back.sessions, d.sessions);
  const csv = Store.toCSV(d);
  assert.ok(csv.includes('"VS Code, ""노션""\n익스텐션"'));
  assert.equal(csv.split('\n')[0].replace('﻿', '').split(',')[0], 'event_id');
  assert.throws(() => Store.fromJSON('{"foo":1}'));
  const n = Store.normalize({ sessions: [{ id: 'a' }], events: [{ id: 'b', ts: 1, type: 'weird' }], activeSessionId: 'zzz' });
  assert.equal(n.sessions.length, 0);
  assert.equal(n.events[0].type, 'return');
  assert.equal(n.activeSessionId, null);
});

test('store: load/save는 저장소 오류에도 죽지 않음', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const r = Store.load(broken);
  assert.equal(r.ok, false);
  assert.equal(r.data.events.length, 0);
  assert.equal(Store.save(broken, r.data), false);
});

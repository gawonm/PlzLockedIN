/*
 * 브라우저 E2E 테스트 (Playwright 필요). 실행: node tests/e2e.mjs
 *  - Playwright가 없으면 SKIP 메시지를 출력하고 종료 코드 0으로 끝남
 *  - SHOTS=<디렉터리> 환경변수를 주면 스크린샷 저장
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.log('SKIP: playwright를 찾을 수 없어 E2E 테스트를 건너뜁니다.');
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

let probe = 0;
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // 캐시 회귀 테스트용: 브라우저에 1시간 캐시하라고 지시하지만 내용은 매번 바뀜
  if (p === '/__probe.txt') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'max-age=3600' }); res.end(String(++probe)); return; }
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const URL_ = `http://localhost:${server.address().port}/index.html`;

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failed++; };
const shot = async (page, name, full = false) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: full }); };
const store = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('focusTracker.v2') || 'null'));

const browser = await chromium.launch();
const errors = [];
const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text())); };

try {
  // ───────── 데스크톱: 핵심 흐름 ─────────
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL_);

  // 회귀: display를 지정한 요소라도 hidden이면 보이지 않아야 함 (1차 버그)
  const leaked = await page.evaluate(() => [...document.querySelectorAll('[hidden]')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id || el.className));
  ok(leaked.length === 0, `[hidden] 요소가 모두 숨겨짐 ${JSON.stringify(leaked)}`);
  ok(await page.locator('#oopsBtn').isVisible(), '홈에 아차! 버튼');

  // 세션 시작 (첫 행동 입력)
  await page.click('[data-tt="class"]');
  await page.fill('#taskInput', 'LangGraph 수업');
  await page.fill('#locationInput', 'Router 노드 구현');
  await page.fill('#nextActionInput', '강의 화면 보고 코드 마지막 줄 확인');
  await page.click('#startBtn');
  ok(await page.isVisible('#activeSession'), '세션 시작');
  await shot(page, 'desktop-session');

  // 사례 A: 원탭 → 즉시 저장 + 돌아갈 일 표시 + 모달 없음 + 자동 종료
  await page.click('#oopsBtn');
  let st = await store(page);
  ok(st.events.length === 1, '버튼 한 번에 즉시 저장');
  const e0 = st.events[0];
  ok(e0.sessionId === st.activeSessionId && e0.taskType === 'class', '활성 세션과 연결');
  ok(typeof e0.tz === 'string' && Number.isFinite(e0.tzOffsetMin), `타임존 저장 (${e0.tz}, ${e0.tzOffsetMin})`);
  ok(e0.returned === 'unknown' && !e0.thought && !e0.activity, '상세 입력 강요 없음(빈 값)');
  ok(await page.isHidden('#sheet'), '모달(상세 시트)이 뜨지 않음');
  ok((await page.textContent('#statusReturnText')).includes('코드 마지막 줄 확인'), '돌아갈 첫 행동 표시');
  await shot(page, 'desktop-recorded');
  await page.waitForSelector('#status', { state: 'hidden', timeout: 8000 });
  ok(true, '아무것도 안 해도 상태 영역이 자동으로 사라짐');

  // 중복 클릭 방지 + 의도적 연속 기록
  await page.click('#oopsBtn');
  await page.click('#oopsBtn', { force: true });
  ok((await store(page)).events.length === 2, '800ms 안 중복 클릭은 1건만');
  await page.waitForTimeout(900);
  await page.click('#oopsBtn');
  ok((await store(page)).events.length === 3, '잠시 후 다시 누르면 새 기록');

  // 되돌리기
  await page.click('#undoBtn');
  ok((await store(page)).events.length === 2, '되돌리기로 방금 기록 삭제');
  await page.waitForTimeout(900);

  // 💭 생각 적어두기
  await page.click('#oopsBtn');
  await page.click('#thoughtBtn');
  await page.keyboard.type('VS Code에서 Notion 쓸 수 있나?');
  await page.keyboard.press('Enter');
  st = await store(page);
  const t = st.events[st.events.length - 1];
  ok(t.thought === 'VS Code에서 Notion 쓸 수 있나?' && t.keepForLater, '생각 보관(보관함에 들어감)');
  ok((await page.textContent('#statusSaved')).includes('보관'), '보관 후에도 돌아갈 일 안내');
  await page.waitForTimeout(900);

  // 자세히 (선택)
  await page.click('#oopsBtn');
  await page.click('#detailBtn');
  ok(await page.isVisible('#sheet'), '자세히 → 시트 열림');
  await shot(page, 'desktop-detail');
  await page.click('[data-ac="search"]');
  await page.click('[data-rt="yes"]');
  await page.fill('#dThought', '영어 단어 뜻');
  await page.click('#sheetDone');
  st = await store(page);
  const d = st.events[st.events.length - 1];
  ok(d.activity === 'search' && d.returned === 'yes' && d.thought === '영어 단어 뜻', '상세 정보 저장');
  ok(d.updatedAt >= d.createdAt, 'updatedAt 갱신');
  ok(await page.isHidden('#sheet') && (await page.textContent('#statusReturnText')).includes('마지막 줄'), '시트 닫으면 돌아갈 일 표시');

  // 키보드 단축키 A
  await page.waitForTimeout(900);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('a');
  ok((await store(page)).events.length === 5, '단축키 A로 기록');

  // 세션 중 잠금
  await page.click('[data-tab="pattern"]');
  ok(await page.isVisible('#tab-pattern .locked-msg'), '세션 중 패턴 탭 잠김');
  await page.click('[data-tab="now"]');

  // 새로고침 유지
  await page.reload();
  ok(await page.isVisible('#activeSession') && (await store(page)).events.length === 5, '새로고침 후 세션·기록 유지');

  // 세션 수정 / 종료
  await page.click('#editSessionBtn');
  await page.fill('#editNextAction', '슬라이드 다시 보기');
  await page.click('#sessionEdit button[type=submit]');
  ok((await page.textContent('#sessionNextAction')) === '슬라이드 다시 보기', '첫 행동 수정');
  await page.click('#endBtn');
  ok(await page.isHidden('#lockBadge'), '세션 종료 → 잠금 해제');
  st = await store(page);
  ok(st.sessions[0].endReason === 'manual', '수동 종료 기록');

  // 보관함
  await page.click('[data-tab="later"]');
  ok((await page.textContent('#laterList')).includes('Notion'), '보관함에 생각 표시');
  ok((await page.textContent('#recentGroups')).includes('연쇄 가능성'), '짧은 간격은 "연쇄 가능성"으로만 표시');
  await shot(page, 'desktop-later', true);

  // 패턴: 데이터 부족 → 해석 제한, 데모 미리보기
  await page.click('[data-tab="pattern"]');
  ok(await page.isVisible('#sufficiencyCard') && await page.isHidden('#insightCard'), '데이터 부족 시 인사이트 숨김');
  await page.click('#demoBtn');
  const insightCount = await page.locator('.insight').count();
  ok(insightCount >= 2, `데모 인사이트 ${insightCount}개`);
  ok(await page.locator('.insight .limit').count() === insightCount, '모든 인사이트에 해석의 한계 포함');
  ok(await page.locator('#calendar .cal-cell.c1, #calendar .cal-cell.c2, #calendar .cal-cell.c3, #calendar .cal-cell.c4').count() > 0, '캘린더 칠해짐');
  await shot(page, 'desktop-pattern', true);
  await page.click('[data-hour-mode="rate"]');
  ok(await page.locator('#hourBars .bar:not(.na)').count() > 0, '시간당 비율 모드');
  await page.click('#demoExit');

  // 데이터: 내보내기 / 가져오기(병합) / 전체 삭제
  await page.click('[data-tab="data"]');
  const [dlJson] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
  const jsonPath = await dlJson.path();
  const exported = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  ok(exported.schemaVersion === 2 && exported.events.length === 5, 'JSON 내보내기');
  const [dlCsv] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsv')]);
  const csv = fs.readFileSync(await dlCsv.path(), 'utf8');
  ok(csv.split('\n').length === 6 && csv.includes('gap_from_prev_in_group_sec'), 'CSV 내보내기');
  await page.setInputFiles('#importFile', jsonPath);
  ok((await page.textContent('#importSummary')).includes('기록 5개'), '가져오기 미리보기');
  page.once('dialog', (dl) => dl.accept());
  await page.click('#importMerge');
  ok((await store(page)).events.length === 5, '같은 파일 병합 → 중복 없음');
  await page.click('#clearBtn');
  await page.fill('#clearInput', '아니');
  await page.click('#clearPanel button[type=submit]');
  ok((await store(page)).events.length === 5, '확인 문구가 틀리면 삭제 안 함');
  await page.fill('#clearInput', '삭제');
  page.once('dialog', (dl) => dl.accept());
  await page.click('#clearPanel button[type=submit]');
  ok((await store(page)).events.length === 0, '전체 삭제');
  await shot(page, 'desktop-data', true);
  await ctx.close();

  // ───────── v1 → v2 마이그레이션 ─────────
  const mctx = await browser.newContext();
  const mp = await mctx.newPage();
  watch(mp);
  await mp.goto(URL_);
  const v1 = {
    version: 1, activeSessionId: null,
    sessions: [{ id: 's1', label: '수업', anchorNote: '슬라이드 12', startAt: Date.now() - 3600e3, endAt: Date.now() - 600e3 }],
    events: [
      { id: 'e1', sessionId: 's1', ts: Date.now() - 3000e3, type: 'return', category: 'curious', note: '단어', durationBucket: 'm5', resolved: false },
      { id: 'e2', sessionId: 's1', ts: Date.now() - 2000e3, type: 'park', category: null, note: '익스텐션', durationBucket: null, resolved: false },
    ],
  };
  await mp.evaluate((v) => { localStorage.clear(); localStorage.setItem('focusTracker.v1', JSON.stringify(v)); }, v1);
  await mp.reload();
  const mst = await store(mp);
  ok(mst && mst.schemaVersion === 2 && mst.events.length === 2, 'v1 기록이 v2로 변환');
  ok(await mp.evaluate(() => !!localStorage.getItem('focusTracker.v1')), 'v1 원본 유지');
  ok((await mp.textContent('#statusSaved')).includes('옮겼어요'), '마이그레이션 안내 표시');
  await mctx.close();

  // ───────── 오프라인 ─────────
  const octx = await browser.newContext();
  const op = await octx.newPage();
  watch(op);
  await op.goto(URL_);
  await op.evaluate(() => navigator.serviceWorker.ready);
  await op.reload();
  await op.evaluate(() => navigator.serviceWorker.ready);
  // 회귀: 서버가 캐시를 허용해도 서비스 워커는 항상 새 파일을 받아야 함 (git pull 후 색이 안 바뀌던 문제)
  ok(await op.evaluate(() => !!navigator.serviceWorker.controller), '서비스 워커가 페이지를 제어');
  const [p1, p2] = await op.evaluate(async () => [await (await fetch('__probe.txt')).text(), await (await fetch('__probe.txt')).text()]);
  ok(p1 !== p2, `업데이트된 파일을 브라우저 캐시 대신 새로 받음 (${p1} → ${p2})`);
  await octx.setOffline(true);
  await op.reload();
  ok(await op.locator('#oopsBtn').isVisible(), '오프라인에서 다시 열기');
  await op.click('#oopsBtn');
  ok((await store(op)).events.length === 1, '오프라인에서 기록');
  await octx.close();

  // ───────── 모바일 375px ─────────
  const mob = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const m = await mob.newPage();
  watch(m);
  await m.goto(URL_);
  await shot(m, 'mobile-home');
  await m.tap('#oopsBtn');
  ok(await m.isVisible('#status'), '모바일 탭 기록');
  await shot(m, 'mobile-recorded');
  for (const tab of ['later', 'pattern', 'data']) {
    await m.tap(`[data-tab="${tab}"]`);
    if (tab === 'pattern') await m.tap('#demoBtn');
    const sw = await m.evaluate(() => document.documentElement.scrollWidth);
    ok(sw <= 375, `모바일 ${tab} 가로 스크롤 없음 (${sw}px)`);
    await shot(m, `mobile-${tab}`, true);
  }
  const small = await m.evaluate(() => [...document.querySelectorAll('#tab-now button, .tab')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 40).map((b) => b.id || b.textContent.trim()));
  ok(small.length === 0, `홈 터치 영역 40px 이상 ${JSON.stringify(small)}`);
  await m.emulateMedia({ colorScheme: 'dark' });
  await m.tap('[data-tab="now"]');
  await shot(m, 'mobile-home-dark');
  await mob.close();

  // ───────── 색 대비 (WCAG AA 4.5:1) — 라이트·다크 ─────────
  for (const scheme of ['light', 'dark']) {
    const cctx = await browser.newContext({ colorScheme: scheme });
    const cp = await cctx.newPage();
    watch(cp);
    await cp.goto(URL_);
    const pairs = await cp.evaluate(() => {
      const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => {
        const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      const cs = (sel) => getComputedStyle(document.querySelector(sel));
      const bodyBg = cs('body').backgroundColor;
      const out = {
        '아차 버튼 글자/배경': ratio(cs('.oops').color, cs('.oops').backgroundColor),
        '본문 글자/배경': ratio(cs('body').color, bodyBg),
        '보조 글자/배경': ratio(cs('.hint').color, bodyBg),
      };
      document.getElementById('oopsBtn').style.transition = 'none';
      document.getElementById('oopsBtn').classList.add('done');
      out['기록됨 상태 버튼'] = ratio(cs('.oops').color, cs('.oops').backgroundColor);
      return out;
    });
    for (const [k, v] of Object.entries(pairs)) ok(v >= 4.5, `${scheme} 대비 ${k} ${v.toFixed(2)}:1`);
    await cctx.close();
  }

  ok(errors.length === 0, `JS 오류 없음 ${JSON.stringify(errors)}`);
} catch (err) {
  console.error(err);
  failed++;
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);

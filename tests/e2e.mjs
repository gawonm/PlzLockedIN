/*
 * 브라우저 E2E 테스트 (Playwright 필요). 실행: node tests/e2e.mjs
 *  - Playwright가 없으면 SKIP을 출력하고 종료 코드 2로 끝남 (PASS로 보고하지 않음)
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
  console.log('SKIP: playwright를 찾을 수 없어 E2E 테스트를 실행하지 못했습니다(통과 아님).');
  process.exit(2);
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
const rawStore = (page) => page.evaluate(() => localStorage.getItem('focusTracker.v2'));
const lastEv = (st) => st.events[st.events.length - 1];

const browser = await chromium.launch();
const errors = [];
const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text())); };
async function fresh(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL_);
  return { ctx, page };
}

/** 근거가 충분한(인사이트가 나오는) 실제 사용자 데이터 형태 — 예시 데이터 생성기를 쓰지 않음 */
function seededUserData(now) {
  const DAY = 864e5;
  const sessions = [];
  const events = [];
  for (let d = 6; d >= 1; d--) {
    const start = now - d * DAY;
    const sid = `seed-s${d}`;
    sessions.push({ id: sid, taskType: 'class', task: '수업', location: '', nextAction: '강의 다시 듣기', startAt: start, endAt: start + 3600e3, endReason: 'manual', createdAt: start, updatedAt: start });
    for (let k = 0; k < 4; k++) {
      const ts = start + (5 + k * 12) * 60e3;
      events.push({ id: `seed-e${d}-${k}`, sessionId: sid, ts, source: 'one-tap', taskType: 'class', thought: '', activity: k < 3 ? 'search' : 'messenger', trigger: null, returned: 'unknown', note: '', keepForLater: false, laterDone: false, chainLink: null, createdAt: ts, updatedAt: ts });
    }
  }
  return { schemaVersion: 2, activeSessionId: null, sessions, events, settings: { experiment: null } };
}

try {
  // ───────── 01 시작 → 02 집중 → 03 돌아보기 ─────────
  {
    const { ctx, page } = await fresh();
    const leaked = await page.evaluate(() => [...document.querySelectorAll('[hidden]')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.id || el.className));
    ok(leaked.length === 0, `[hidden] 요소가 모두 숨겨짐 ${JSON.stringify(leaked)}`);
    ok((await page.textContent('#stateLabel')) === '시작 전', '헤더: 시작 전');
    ok((await page.textContent('#startTitle')).includes('돌아오면 무엇부터'), '시작 화면 제목');
    ok(!(await page.locator('#startMore').evaluate((d) => d.open)), '추가 정보는 기본 접힘');
    ok(await page.isHidden('#resumeBtn'), '이전 세션이 없으면 "최근 작업 이어하기" 숨김');
    await shot(page, 'desktop-start');

    // 빈 값으로 시작 → 유령 세션 없음
    await page.click('#startForm button[type=submit]');
    ok(await page.isVisible('#startHint'), '빈 첫 행동이면 안내');
    ok((await store(page)) === null || (await store(page)).sessions.length === 0, '빈 값으로 세션을 만들지 않음');

    // 세션 없이 기록 (원탭, 되돌리기, 생각 맡기기)
    await page.click('#quickRecordBtn');
    let st = await store(page);
    ok(st.events.length === 1 && st.events[0].sessionId === null, '세션 없이 원탭 기록');
    ok((await page.textContent('#statusGuide')).includes('하던 일의 다음 한 단계'), '세션 없을 때 기본 복귀 안내');
    await page.click('#undoBtn');
    ok((await store(page)).events.length === 0, '세션 없는 기록 되돌리기');
    await page.waitForTimeout(900);

    // 한 줄 입력으로 시작
    await page.fill('#nextActionInput', '강의 화면에서 다음 설명 듣기');
    await page.click('#startForm button[type=submit]');
    st = await store(page);
    ok(st.sessions.length === 1 && st.activeSessionId === st.sessions[0].id, '한 줄 입력으로 세션 시작');
    ok((await page.textContent('#stateLabel')) === '집중 중', '헤더: 집중 중');
    ok((await page.textContent('#focusAction')) === '강의 화면에서 다음 설명 듣기', '첫 행동이 가장 먼저 보임');
    ok(await page.isHidden('#tabs'), '집중 중 탭(통계·보관함·데이터) 숨김');
    const noise = await page.evaluate(() => ['sessionElapsed', 'kpis'].map((id) => { const el = document.getElementById(id); return el && el.offsetParent !== null; }));
    ok(!noise.some(Boolean), '집중 화면에 경과시간·통계 없음');
    await shot(page, 'desktop-focus');

    // 원탭 기록: 즉시 저장, 모달 없음, 같은 위치 확인 문구
    await page.click('#oopsBtn');
    st = await store(page);
    const e0 = lastEv(st);
    ok(st.events.length === 1 && e0.sessionId === st.activeSessionId, '집중 중 원탭 기록 → 세션 연결');
    ok(typeof e0.tz === 'string' && Number.isFinite(e0.tzOffsetMin), '타임존 저장');
    ok(await page.isHidden('#sheet'), '모달 없음');
    ok(/^\d\d:\d\d 기록했어요$/.test(await page.textContent('#statusSaved')), '"HH:MM 기록했어요"');
    ok((await page.textContent('#statusGuide')).includes('첫 행동'), '짧은 복귀 안내');
    ok((await page.textContent('#oopsSub')).includes('기록했어요'), '버튼 문구도 실제 저장 결과와 일치');
    await shot(page, 'desktop-recorded');
    await page.waitForSelector('#status', { state: 'hidden', timeout: 8000 });
    ok(true, '아무것도 안 해도 상태 영역이 사라짐');

    // 중복 방지 + 연속 기록 + 되돌리기
    await page.click('#oopsBtn');
    await page.click('#oopsBtn', { force: true });
    ok((await store(page)).events.length === 2, '800ms 안 중복 클릭은 1건');
    await page.waitForTimeout(900);
    await page.click('#oopsBtn');
    ok((await store(page)).events.length === 3, '잠시 후 다시 누르면 새 기록');
    await page.click('#undoBtn');
    ok((await store(page)).events.length === 2, '되돌리기');
    await page.waitForTimeout(900);

    // 생각 한 줄 맡기기: 제출 전 새로고침해도 유지
    await page.click('#oopsBtn');
    await page.click('#thoughtBtn');
    await page.keyboard.type('VS Code에서 Notion 쓸 수 있나?');
    await page.waitForTimeout(700);
    ok((await page.textContent('#thoughtSaveNote')).includes('자동 저장'), '입력 중 자동 저장 표시');
    await page.reload();
    st = await store(page);
    ok(lastEv(st).thought === 'VS Code에서 Notion 쓸 수 있나?' && lastEv(st).keepForLater, '제출 전 새로고침해도 메모 유지');
    ok(await page.isVisible('#screenFocus'), '새로고침 후 집중 화면 유지');
    await page.waitForTimeout(900);

    // 맡기기 제출
    await page.click('#oopsBtn');
    await page.click('#thoughtBtn');
    await page.fill('#thoughtInput', '영어 단어 뜻');
    ok((await page.textContent('#thoughtForm button[type=submit]')).includes('보관하고 하던 일로 돌아가기'), '제출 버튼 문구');
    await page.press('#thoughtInput', 'Enter');
    ok(lastEv(await store(page)).thought === '영어 단어 뜻', '맡기기 저장');
    ok(await page.isHidden('#thoughtForm') && (await page.textContent('#statusSaved')).includes('맡겼어요'), '입력 접고 복귀 안내');
    await page.waitForTimeout(900);

    // 자세히 (선택)
    await page.click('#oopsBtn');
    await page.click('#detailBtn');
    await page.click('[data-ac="search"]');
    await page.click('#sheetDone');
    ok(lastEv(await store(page)).activity === 'search', '상세 기록(선택) 저장');
    await page.waitForTimeout(900);

    // 단축키 A (한글 입력기 'ㅁ' 포함), 입력칸에서는 무시
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const before = (await store(page)).events.length;
    await page.keyboard.press('a');
    ok((await store(page)).events.length === before + 1, '단축키 A');
    await page.waitForTimeout(900);
    await page.dispatchEvent('body', 'keydown', { key: 'ㅁ' });
    ok((await store(page)).events.length === before + 2, '한글 자판 상태의 A(ㅁ)');

    // 돌아갈 행동 인라인 수정 (같은 세션 유지)
    const sid = (await store(page)).activeSessionId;
    await page.click('#editActionBtn');
    await page.fill('#editNextAction', '슬라이드 14부터 보기');
    await page.press('#editNextAction', 'Enter');
    st = await store(page);
    ok(st.activeSessionId === sid && st.sessions.find((s) => s.id === sid).nextAction === '슬라이드 14부터 보기', '첫 행동 인라인 수정(같은 세션)');
    ok((await page.textContent('#focusAction')) === '슬라이드 14부터 보기', '수정한 첫 행동 표시');
    ok(await page.isVisible('#screenFocus'), '수정 후에도 집중 화면');

    // 집중 마치기 → 돌아보기
    await page.click('#endBtn');
    st = await store(page);
    ok(st.activeSessionId === null && st.sessions[0].endReason === 'manual', '집중 마치기');
    ok(await page.isVisible('#screenReview') && (await page.textContent('#stateLabel')) === '돌아보기', '돌아보기 화면');
    ok(await page.isVisible('#tabs'), '마친 뒤 탭 잠금 해제');
    const days = await page.locator('#reviewDays li').allTextContents();
    ok(days.length === 7 && days.some((t) => t.includes('미기록')), `최근 7일, 기록 없는 날은 "미기록" (${days.join(' | ')})`);
    ok(await page.isVisible('#reviewObserving') && await page.isHidden('#reviewInsight'), '근거 부족 → "아직 관찰 중이에요"');
    ok(!(await page.textContent('#screenReview')).includes('15/'), '수집 진행률(15/15) 없음');
    await shot(page, 'desktop-review-observing', true);

    // 오늘은 여기까지
    await page.click('#doneTodayBtn');
    ok(await page.isVisible('#screenDone') && (await page.textContent('#doneText')).includes('직접 닫아도'), '종료 상태 표시(창을 닫았다고 주장하지 않음)');
    await page.click('#restartBtn');

    // 최근 작업 이어하기 → 새 세션
    ok(await page.isVisible('#resumeBtn') && (await page.textContent('#resumeText')) === '슬라이드 14부터 보기', '최근 작업 이어하기 표시');
    await page.click('#resumeBtn');
    st = await store(page);
    ok(st.sessions.length === 2 && st.activeSessionId !== sid && st.sessions.find((s) => s.id === sid).endAt != null, '이어하기 = 새 세션, 이전 세션은 종료 상태 유지');
    await page.click('#endBtn');
    await ctx.close();
  }

  // ───────── 돌아보기: 관찰 하나 · 실험 하나 · 다음 세션에 유지 ─────────
  {
    const { ctx, page } = await fresh();
    await page.evaluate((d) => localStorage.setItem('focusTracker.v2', JSON.stringify(d)), seededUserData(Date.now()));
    await page.reload();
    await page.fill('#nextActionInput', '과제 2번 문제');
    await page.click('#startForm button[type=submit]');
    await page.click('#oopsBtn');
    await page.click('#endBtn');
    ok(await page.isVisible('#reviewInsight') && await page.isVisible('#reviewExperiment'), '근거가 있으면 관찰·실험 카드');
    ok(await page.locator('#screenReview .insight, #screenReview #reviewInsight').count() === 1, '기본 화면 관찰은 하나');
    ok((await page.textContent('#riFact')).includes('"검색"(이)라고 남긴 기록이 18번'), `사용자 데이터 기반 사실 (${await page.textContent('#riFact')})`);
    ok((await page.textContent('#riLimit')).includes('원인을 알 수는 없'), '해석의 한계');
    const expText = await page.textContent('#reText');
    await shot(page, 'desktop-review', true);
    await page.click('#reChoose');
    let st = await store(page);
    ok(st.settings.experiment && st.settings.experiment.text === expText, '실험 선택이 저장됨');
    await page.click('#nextFocusBtn');
    ok(await page.isVisible('#expStart') && (await page.textContent('#expStartText')) === expText, '다음 시작 화면에 실험 표시');
    await page.reload();
    ok(await page.isVisible('#expStart'), '새로고침 후에도 실험 유지');
    await page.fill('#nextActionInput', '과제 3번 문제');
    await page.click('#startForm button[type=submit]');
    st = await store(page);
    const active = st.sessions.find((s) => s.id === st.activeSessionId);
    ok(active.experimentId === st.settings.experiment.id, '새 세션에 실험 ID 기록');
    ok(await page.isVisible('#expFocus') && (await page.textContent('#expFocusText')) === expText, '집중 화면에 실험 표시');
    await page.click('#endBtn');
    await page.click('#nextFocusBtn');
    await page.click('#expStartClear');
    ok((await store(page)).settings.experiment === null && await page.isHidden('#expStart'), '실험 그만하기');

    // 예시 데이터가 사용자 데이터와 섞이지 않음
    await page.click('[data-tab="pattern"]');
    const userTotal = (await store(page)).events.length;
    await page.evaluate(() => { document.getElementById('demoBtn').hidden = false; document.getElementById('sufficiencyCard').hidden = false; });
    await page.click('#demoBtn');
    ok(await page.isVisible('#demoNotice'), '예시 데이터 미리보기');
    ok((await store(page)).events.length === userTotal, '예시 데이터는 저장되지 않음');
    await page.click('[data-tab="now"]');
    await page.click('#endBtn').catch(() => {});
    await ctx.close();
  }

  // ───────── 저장 실패: 성공 표시 없음, 입력 유지, 백업 가능 ─────────
  {
    const { ctx, page } = await fresh();
    await page.fill('#nextActionInput', '코드 리뷰');
    await page.click('#startForm button[type=submit]');
    await page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }; });
    await page.click('#oopsBtn');
    const saved = await page.textContent('#statusSaved');
    ok(saved.startsWith('⚠') && !saved.includes('기록했어요\u0000'), `저장 실패 시 성공 표시 없음 (${saved})`);
    ok(!(await page.textContent('#oopsSub')).includes('✓'), '버튼에도 성공 표시 없음');
    ok(await page.isVisible('#banner') && await page.locator('[data-bn="bnBackup"]').isVisible(), '저장 실패 배너 + 백업 버튼 (집중 잠금 중에도)');
    await page.click('#thoughtBtn');
    await page.fill('#thoughtInput', '저장 안 될 생각');
    await page.press('#thoughtInput', 'Enter');
    ok(await page.isVisible('#thoughtForm') && (await page.inputValue('#thoughtInput')) === '저장 안 될 생각', '저장 실패 시 입력 유지');
    ok((await page.textContent('#thoughtSaveNote')).includes('저장하지 못했어요'), '메모 저장 실패 안내');
    await page.waitForTimeout(6500);
    ok(await page.isVisible('#thoughtForm'), '저장 실패한 입력은 자동으로 사라지지 않음');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-bn="bnBackup"]')]);
    const backup = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    ok(backup.events.some((e) => e.thought === '저장 안 될 생각'), '백업에 저장 못 한 메모 포함');
    await shot(page, 'desktop-save-failed');
    await ctx.close();
  }

  // ───────── 손상 데이터: 덮어쓰지 않음, 원본 보관 후 새로 시작 ─────────
  {
    const { ctx, page } = await fresh();
    const BROKEN = '{"schemaVersion":2,"events":[{"id":"x","ts":1';
    await page.evaluate((b) => localStorage.setItem('focusTracker.v2', b), BROKEN);
    await page.reload();
    ok(await page.isVisible('#banner') && (await page.textContent('#bannerText')).includes('덮어쓰지 않도록'), '손상 데이터 안내');
    await page.click('#quickRecordBtn');
    ok((await rawStore(page)) === BROKEN, '기록해도 손상 원본을 덮어쓰지 않음');
    ok((await page.textContent('#statusSaved')).startsWith('⚠'), '손상 보호 중 기록은 "이 창에만" 표시');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-bn="bnRaw"]')]);
    ok(fs.readFileSync(await dl.path(), 'utf8') === BROKEN, '손상 원본 내려받기');
    await shot(page, 'desktop-corrupt');
    await page.click('[data-bn="bnFresh"]');
    const keys = await page.evaluate(() => Object.keys(localStorage));
    const qk = keys.find((k) => k.startsWith('focusTracker.corrupt.'));
    ok(qk && (await page.evaluate((k) => localStorage.getItem(k), qk)) === BROKEN, '원본을 별도 키에 보관');
    const st = await store(page);
    ok(st && st.events.length === 1, '새로 시작 후 이 창의 기록이 저장됨');
    ok(await page.isHidden('#banner'), '안내 닫힘');
    await page.reload();
    ok(await page.isHidden('#banner'), '새로고침 후 정상');
    await ctx.close();
  }

  // ───────── 손상 데이터: 백업 파일로 복구 ─────────
  {
    const { ctx, page } = await fresh();
    const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-backup.json');
    fs.writeFileSync(tmp, JSON.stringify({ schema: 'focus-tracker', schemaVersion: 2, ...seededUserData(Date.now()) }));
    await page.evaluate(() => localStorage.setItem('focusTracker.v2', 'garbage'));
    await page.reload();
    page.on('dialog', (d) => d.accept());
    await page.setInputFiles('#recoverFile', tmp);
    await page.waitForTimeout(300);
    fs.unlinkSync(tmp);
    const st = await store(page);
    ok(st && st.events.length === 24 && await page.isHidden('#banner'), '백업 파일로 복구');
    await ctx.close();
  }

  // ───────── 데이터 탭: 내보내기 / 병합 / 전체 삭제 ─────────
  {
    const { ctx, page } = await fresh();
    await page.evaluate((d) => localStorage.setItem('focusTracker.v2', JSON.stringify(d)), seededUserData(Date.now()));
    await page.reload();
    await page.click('[data-tab="data"]');
    const [dlJson] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
    const jsonPath = await dlJson.path();
    ok(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).events.length === 24, 'JSON 내보내기');
    const [dlCsv] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsv')]);
    ok(fs.readFileSync(await dlCsv.path(), 'utf8').includes('gap_from_prev_in_group_sec'), 'CSV 내보내기');
    await page.setInputFiles('#importFile', jsonPath);
    page.once('dialog', (d) => d.accept());
    await page.click('#importMerge');
    ok((await store(page)).events.length === 24, '같은 파일 병합 → 중복 없음');
    await page.click('#clearBtn');
    await page.fill('#clearInput', '삭제');
    page.once('dialog', (d) => d.accept());
    await page.click('#clearPanel button[type=submit]');
    ok((await store(page)).events.length === 0, '전체 삭제');
    await ctx.close();
  }

  // ───────── v1 → v2 마이그레이션 ─────────
  {
    const { ctx, page } = await fresh();
    const v1 = {
      version: 1, activeSessionId: null,
      sessions: [{ id: 's1', label: '수업', anchorNote: '슬라이드 12', startAt: Date.now() - 3600e3, endAt: Date.now() - 600e3 }],
      events: [
        { id: 'e1', sessionId: 's1', ts: Date.now() - 3000e3, type: 'return', category: 'curious', note: '단어', durationBucket: 'm5', resolved: false },
        { id: 'e2', sessionId: 's1', ts: Date.now() - 2000e3, type: 'park', category: null, note: '익스텐션', durationBucket: null, resolved: false },
      ],
    };
    await page.evaluate((v) => { localStorage.clear(); localStorage.setItem('focusTracker.v1', JSON.stringify(v)); }, v1);
    await page.reload();
    const st = await store(page);
    ok(st && st.events.length === 2, 'v1 기록이 v2로 변환');
    ok(await page.evaluate(() => !!localStorage.getItem('focusTracker.v1')), 'v1 원본 유지');
    ok((await page.textContent('#statusSaved')).includes('옮겼어요'), '마이그레이션 안내');
    ok(await page.isVisible('#resumeBtn') && (await page.textContent('#resumeText')) === '수업', '이전 버전 세션도 이어하기 가능');
    await ctx.close();
  }

  // ───────── 오프라인 + 업데이트 반영 ─────────
  {
    const { ctx, page } = await fresh();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);
    ok(await page.evaluate(() => !!navigator.serviceWorker.controller), '서비스 워커가 페이지를 제어');
    const [p1, p2] = await page.evaluate(async () => [await (await fetch('__probe.txt')).text(), await (await fetch('__probe.txt')).text()]);
    ok(p1 !== p2, `업데이트된 파일을 브라우저 캐시 대신 새로 받음 (${p1} → ${p2})`);
    await ctx.setOffline(true);
    await page.reload();
    ok(await page.isVisible('#screenStart'), '오프라인에서 다시 열기');
    await page.click('#quickRecordBtn');
    ok((await store(page)).events.length === 1, '오프라인에서 기록');
    await ctx.close();
  }

  // ───────── 반응형: 375px 모바일 / 작은 데스크톱 창 / 다크 모드 ─────────
  for (const [name, vp, mobile] of [['mobile', { width: 375, height: 812 }, true], ['small-window', { width: 520, height: 640 }, false]]) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
    const m = await ctx.newPage();
    watch(m);
    await m.goto(URL_);
    await m.evaluate((d) => localStorage.setItem('focusTracker.v2', JSON.stringify(d)), seededUserData(Date.now()));
    await m.reload();
    const widths = [];
    const check = async (label) => { const sw = await m.evaluate(() => document.documentElement.scrollWidth); widths.push(sw); ok(sw <= vp.width, `${name} ${label} 가로 넘침 없음 (${sw}px)`); };
    await m.locator('#startMore summary').click();
    await check('시작');
    await shot(m, `${name}-start`, true);
    await m.fill('#nextActionInput', '아주 긴 첫 행동 문장이 들어가도 화면 밖으로 넘치지 않아야 합니다 — 강의 화면에서 다음 설명 듣기');
    await m.click('#startForm button[type=submit]');
    await m.click('#oopsBtn');
    await m.click('#thoughtBtn');
    await check('집중');
    const box = await m.locator('#oopsBtn').boundingBox();
    ok(box && box.y < vp.height, `${name} 아차 버튼이 첫 화면 안에 보임`);
    await shot(m, `${name}-focus`);
    await m.click('#endBtn');
    await check('돌아보기');
    await shot(m, `${name}-review`, true);
    for (const tab of ['later', 'pattern', 'data']) { await m.click(`[data-tab="${tab}"]`); await check(tab); }
    const small = await m.evaluate(() => [...document.querySelectorAll('button, input, summary')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 32 && !b.classList.contains('link-btn') && !b.classList.contains('sr-only')).map((b) => b.id || b.textContent.trim().slice(0, 12)));
    ok(small.length === 0, `${name} 터치 영역 ${JSON.stringify(small)}`);
    await m.click('[data-tab="now"]');
    await m.emulateMedia({ colorScheme: 'dark' });
    await shot(m, `${name}-review-dark`, true);
    // 키보드 포커스가 보이는지
    await m.keyboard.press('Tab');
    const outline = await m.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    ok(outline !== 'none', `${name} 키보드 포커스 표시 (${outline})`);
    await ctx.close();
  }

  // ───────── 색 대비 (WCAG AA 4.5:1) — 라이트·다크 ─────────
  for (const scheme of ['light', 'dark']) {
    const { ctx, page } = await fresh({ colorScheme: scheme });
    await page.fill('#nextActionInput', '대비 확인');
    await page.click('#startForm button[type=submit]');
    const pairs = await page.evaluate(() => {
      const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      const cs = (sel) => getComputedStyle(document.querySelector(sel));
      const bg = cs('body').backgroundColor;
      const btn = document.getElementById('oopsBtn');
      btn.style.transition = 'none';
      const out = {
        '아차 버튼': ratio(cs('.oops').color, cs('.oops').backgroundColor),
        '첫 행동': ratio(cs('#focusAction').color, bg),
        '보조 라벨': ratio(cs('.eyebrow').color, bg),
        '보조 설명': ratio(cs('.hint').color, bg),
      };
      btn.classList.add('done');
      out['기록됨 상태'] = ratio(cs('.oops').color, cs('.oops').backgroundColor);
      return out;
    });
    for (const [k, v] of Object.entries(pairs)) ok(v >= 4.5, `${scheme} 대비 ${k} ${v.toFixed(2)}:1`);
    await ctx.close();
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

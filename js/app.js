/* app.js — UI 상태, 세션, 퀵캡처, 잠금 모드, 렌더링 */
(function () {
  'use strict';
  const S = window.FocusStats;
  const Store = window.FocusStore;

  const SHEET_AUTO_MS = 8000; // 아무것도 안 하면 8초 뒤 자동 저장
  const SHEET_HARD_CAP_MS = 30000; // 타이핑 중이어도 30초 지나면 강제 저장
  const ANCHOR_MS = 1500;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 저장소 ----------
  let storage = null;
  try { storage = window.localStorage; } catch (e) { storage = null; }
  const memoryStorage = { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = v; } };
  const loaded = Store.load(storage || memoryStorage);
  let data = loaded.data;
  if (!storage || !loaded.ok) showBanner('⚠️ 브라우저 저장소를 쓸 수 없어요. 이 창을 닫으면 기록이 사라질 수 있으니 JSON 백업을 이용하세요.');

  function persist() {
    if (!Store.save(storage || memoryStorage, data)) {
      showBanner('⚠️ 저장에 실패했어요(저장 공간 부족 또는 사생활 보호 모드). JSON 백업을 내려받아 두세요.');
    }
  }
  function showBanner(msg) { const b = $('banner'); b.textContent = msg; b.hidden = false; }

  const ui = {
    tab: 'now',
    viewMonth: new Date().getMonth(),
    viewYear: new Date().getFullYear(),
    yearView: new Date().getFullYear(),
    label: '',
    demo: null,
  };

  const activeSession = () => (data.activeSessionId ? data.sessions.find((s) => s.id === data.activeSessionId) : null);

  // ---------- 탭 & 잠금 ----------
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  function switchTab(tab) {
    ui.tab = tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    renderTab();
  }

  function applyLock() {
    const locked = !!activeSession();
    $('lockBadge').hidden = !locked;
    document.querySelectorAll('.tab[data-lockable]').forEach((t) => t.classList.toggle('locked', locked));
    ['tracker', 'parking', 'report'].forEach((id) => $(`tab-${id}`).classList.toggle('locked', locked));
  }

  // ---------- 세션 ----------
  $('labelChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    ui.label = c.dataset.label;
    $('labelInput').value = '';
    $('labelChips').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
  });
  $('labelInput').addEventListener('input', () => {
    ui.label = '';
    $('labelChips').querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
  });

  $('startBtn').addEventListener('click', () => {
    const label = $('labelInput').value.trim() || ui.label || '집중';
    const s = { id: Store.uid('s'), label, anchorNote: $('anchorInput').value.trim(), startAt: Date.now(), endAt: null };
    data.sessions.push(s);
    data.activeSessionId = s.id;
    persist();
    $('labelInput').value = '';
    $('anchorInput').value = '';
    renderAll();
  });

  $('endBtn').addEventListener('click', () => {
    const s = activeSession();
    if (!s) return;
    s.endAt = Date.now();
    data.activeSessionId = null;
    persist();
    const evs = data.events.filter((e) => e.sessionId === s.id);
    renderAll();
    const parks = evs.filter((e) => e.type === 'park').length;
    const msg = `세션 종료 · ${S.fmtMin(s.endAt - s.startAt)} 동안 흔들림 ${evs.length}회 (🅿️ ${parks} / ↩️ ${evs.length - parks})`;
    flashAnchor('수고했어요', msg, 2200);
  });

  $('anchorLive').addEventListener('change', () => {
    const s = activeSession();
    if (!s) return;
    s.anchorNote = $('anchorLive').value.trim();
    persist();
  });

  // ---------- 기록 (원탭) ----------
  $('parkBtn').addEventListener('click', () => record('park'));
  $('returnBtn').addEventListener('click', () => record('return'));

  function record(type) {
    if (sheet.open) closeSheet();
    const s = activeSession();
    const ev = {
      id: Store.uid('e'), sessionId: s ? s.id : null, ts: Date.now(), type,
      category: null, note: '', durationBucket: null, resolved: false,
    };
    data.events.push(ev); // 버튼을 누른 순간 이미 저장 → 이후 입력은 전부 선택 사항
    persist();
    renderNow();
    openSheet(ev);
  }

  // ---------- 퀵캡처 시트 ----------
  const sheet = { open: false, ev: null, openedAt: 0, remaining: SHEET_AUTO_MS, last: 0, paused: false, raf: 0 };

  $('catChips').innerHTML = S.CATEGORIES.map((c) => `<button class="chip" data-cat="${c.id}">${c.emoji} ${esc(c.label)}</button>`).join('');
  $('durChips').innerHTML = S.DURATIONS.map((d) => `<button class="chip" data-dur="${d.id}">⏳ ${esc(d.label)}</button>`).join('');

  $('catChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c || !sheet.ev) return;
    sheet.ev.category = sheet.ev.category === c.dataset.cat ? null : c.dataset.cat;
    $('catChips').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x.dataset.cat === sheet.ev.category));
    sheet.remaining = Math.max(sheet.remaining, 4000);
  });
  $('durChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c || !sheet.ev) return;
    sheet.ev.durationBucket = sheet.ev.durationBucket === c.dataset.dur ? null : c.dataset.dur;
    $('durChips').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x.dataset.dur === sheet.ev.durationBucket));
    sheet.remaining = Math.max(sheet.remaining, 4000);
  });
  $('noteInput').addEventListener('input', () => { sheet.paused = $('noteInput').value.length > 0; });
  $('noteInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); closeSheet(); }
  });
  $('sheetDone').addEventListener('click', () => closeSheet());
  $('sheetBackdrop').addEventListener('click', () => closeSheet());

  function openSheet(ev) {
    Object.assign(sheet, { open: true, ev, openedAt: performance.now(), remaining: SHEET_AUTO_MS, last: performance.now(), paused: false });
    const isPark = ev.type === 'park';
    $('sheetTitle').textContent = isPark ? '🅿️ 무슨 생각이 떠올랐나요?' : '↩️ 어디 다녀왔나요?';
    $('noteInput').placeholder = isPark ? '나중에 할 것 (예: VS Code 노션 익스텐션 찾기)' : '무엇을 했나요 (예: 영어 단어 검색)';
    $('noteInput').value = '';
    $('durChips').hidden = isPark;
    $('catChips').querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
    $('durChips').querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
    $('sheet').hidden = false;
    $('sheetBackdrop').hidden = false;
    // 데스크톱(정밀 포인터)에서는 바로 타이핑 가능하게. 모바일은 키보드가 칩을 가리지 않도록 자동 포커스 안 함.
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) $('noteInput').focus();
    cancelAnimationFrame(sheet.raf);
    sheet.raf = requestAnimationFrame(tickSheet);
  }

  function tickSheet(now) {
    if (!sheet.open) return;
    const dt = now - sheet.last;
    sheet.last = now;
    if (!sheet.paused) sheet.remaining -= dt;
    const hardLeft = SHEET_HARD_CAP_MS - (now - sheet.openedAt);
    const frac = sheet.paused ? Math.max(0, hardLeft / SHEET_HARD_CAP_MS) : Math.max(0, sheet.remaining / SHEET_AUTO_MS);
    $('countdownBar').style.transform = `scaleX(${Math.min(1, frac)})`;
    document.querySelector('.countdown').classList.toggle('paused', sheet.paused);
    $('sheetHint').textContent = sheet.paused
      ? `입력 중엔 기다려요 · ${Math.ceil(hardLeft / 1000)}초 뒤 자동 저장 (Enter로 바로 저장)`
      : `선택 사항이에요. ${Math.max(0, Math.ceil(sheet.remaining / 1000))}초 뒤 자동으로 저장하고 닫혀요.`;
    if (sheet.remaining <= 0 || hardLeft <= 0) { closeSheet(); return; }
    sheet.raf = requestAnimationFrame(tickSheet);
  }

  function closeSheet() {
    if (!sheet.open) return;
    sheet.open = false;
    cancelAnimationFrame(sheet.raf);
    const ev = sheet.ev;
    ev.note = $('noteInput').value.trim();
    persist();
    $('noteInput').blur();
    $('sheet').hidden = true;
    $('sheetBackdrop').hidden = true;
    renderNow();
    const s = activeSession();
    if (s) flashAnchor(`${s.label}(으)로 돌아가기`, s.anchorNote ? `📍 ${s.anchorNote}` : '');
    else flashAnchor('하던 일로 돌아가기', ev.type === 'park' ? '생각은 주차장에 잘 보관했어요' : '');
  }

  // ---------- 복귀 앵커 ----------
  let anchorTimer = 0;
  function flashAnchor(big, note, ms) {
    $('anchorTask').textContent = big;
    $('anchorNote').textContent = note || '';
    $('anchor').hidden = false;
    clearTimeout(anchorTimer);
    anchorTimer = setTimeout(hideAnchor, ms || ANCHOR_MS);
  }
  function hideAnchor() { $('anchor').hidden = true; }
  $('anchor').addEventListener('click', hideAnchor);

  // ---------- 키보드 단축키 ----------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.open) { closeSheet(); return; }
    const tag = (e.target.tagName || '').toLowerCase();
    if (sheet.open || tag === 'input' || tag === 'select' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space' || e.key === 'a' || e.key === 'A') { e.preventDefault(); record('return'); }
    else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); record('park'); }
  });

  // ---------- 렌더: 지금 ----------
  function renderNow() {
    const s = activeSession();
    $('idleSession').hidden = !!s;
    $('activeSession').hidden = !s;
    $('endBtn').hidden = !s;
    if (!s) return;
    $('sessionLabel').textContent = s.label;
    if (document.activeElement !== $('anchorLive')) $('anchorLive').value = s.anchorNote || '';
    const evs = data.events.filter((e) => e.sessionId === s.id);
    $('cntPark').textContent = evs.filter((e) => e.type === 'park').length;
    $('cntRet').textContent = evs.filter((e) => e.type === 'return').length;
    tickClock();
  }

  function tickClock() {
    const s = activeSession();
    if (!s) return;
    const now = Date.now();
    const ms = now - s.startAt;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    $('sessionTimer').textContent = (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    const evs = data.events.filter((e) => e.sessionId === s.id);
    const lastTs = evs.length ? Math.max(...evs.map((e) => e.ts)) : s.startAt;
    $('streak').textContent = S.fmtMin(now - lastTs);
  }
  setInterval(tickClock, 1000);

  // ---------- 렌더: 트래커 ----------
  $('prevMonth').addEventListener('click', () => shiftMonth(-1));
  $('nextMonth').addEventListener('click', () => shiftMonth(1));
  $('prevYear').addEventListener('click', () => { ui.yearView -= 1; renderTracker(); });
  $('nextYear').addEventListener('click', () => { ui.yearView += 1; renderTracker(); });
  function shiftMonth(d) {
    const dt = new Date(ui.viewYear, ui.viewMonth + d, 1);
    ui.viewYear = dt.getFullYear();
    ui.viewMonth = dt.getMonth();
    renderTracker();
  }

  function renderTracker() {
    const y = ui.viewYear;
    const mo = ui.viewMonth;
    $('monthTitle').textContent = `${y}년 ${mo + 1}월`;
    const mx = S.monthHourMatrix(data.events, y, mo);
    let html = '<div></div>';
    for (let h = 0; h < 24; h++) html += `<div class="h">${h % 3 === 0 ? h : ''}</div>`;
    mx.forEach((row, i) => {
      html += `<div class="d">${i + 1}</div>`;
      row.forEach((c, h) => {
        const cls = c === 0 ? '' : `hm${Math.min(c, 4)}`;
        html += `<div class="cell ${cls}" title="${mo + 1}/${i + 1} ${h}시 · ${c}회"></div>`;
      });
    });
    $('monthGrid').innerHTML = html;
    $('monthLegend').innerHTML = ['0', '1', '2', '3', '4+'].map((l, i) => `<span><i style="background:var(--hm${i})"></i>${l}회</span>`).join('');

    const Y = ui.yearView;
    $('yearTitle').textContent = `${Y}년`;
    const days = S.dailySummary(data);
    const todayKey = S.dateKey(Date.now());
    let yh = '<div></div>';
    for (let m = 0; m < 12; m++) yh += `<div class="h">${m + 1}</div>`;
    for (let d = 1; d <= 31; d++) {
      yh += `<div class="d">${d}</div>`;
      for (let m = 0; m < 12; m++) {
        const dim = new Date(Y, m + 1, 0).getDate();
        if (d > dim) { yh += '<div class="cell void"></div>'; continue; }
        const k = S.dateKey(new Date(Y, m, d).getTime());
        const info = days[k];
        const lv = info ? info.level : 0;
        const tip = info
          ? `${m + 1}/${d} · 흔들림 ${info.count}회 (🅿️${info.park} ↩️${info.ret})${info.focusMs ? ` · 집중 ${S.fmtMin(info.focusMs)}` : ''}`
          : `${m + 1}/${d}`;
        yh += `<div class="cell ${lv ? 'lv' + lv : ''} ${k === todayKey ? 'today' : ''}" title="${tip}"></div>`;
      }
    }
    $('yearGrid').innerHTML = yh;
    $('yearLegend').innerHTML = S.LEVELS.map((l) => `<span title="${l.hint}"><i style="background:var(--lv${l.level})"></i>${l.label}</span>`).join('') + '<span><i style="background:var(--lv0)"></i>기록 없음</span>';
  }

  // ---------- 렌더: 주차장 / 정리함 ----------
  function fmtWhen(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function renderParking() {
    const parks = data.events.filter((e) => e.type === 'park').sort((a, b) => b.ts - a.ts);
    const open = parks.filter((e) => !e.resolved);
    const done = parks.filter((e) => e.resolved);
    $('parkCount').textContent = `${open.length}개 대기`;
    const item = (e) => {
      const c = S.categoryOf(e.category);
      return `<li class="${e.resolved ? 'done' : ''}" data-id="${e.id}">
        <input type="checkbox" data-act="resolve" ${e.resolved ? 'checked' : ''} aria-label="처리 완료" />
        <span class="txt">${c ? c.emoji + ' ' : ''}${e.note ? esc(e.note) : '<span class="muted">(메모 없음)</span>'}</span>
        <span class="meta">${fmtWhen(e.ts)}</span>
        <button class="icon-btn" data-act="delete" aria-label="삭제">✕</button></li>`;
    };
    $('parkList').innerHTML = open.length ? open.map(item).join('') : '<li class="empty">주차한 생각이 없어요.</li>';
    $('parkDoneList').innerHTML = done.length ? done.map(item).join('') : '<li class="empty">아직 없어요.</li>';

    const logs = [...data.events].sort((a, b) => b.ts - a.ts).slice(0, 50);
    const catOpts = (sel) => `<option value="">분류 없음</option>` + S.CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.emoji} ${esc(c.label)}</option>`).join('');
    $('logList').innerHTML = logs.length
      ? logs.map((e) => `<li class="log-item" data-id="${e.id}">
          <span class="meta">${e.type === 'park' ? '🅿️' : '↩️'} ${fmtWhen(e.ts)}${e.durationBucket ? ' · ' + esc((S.DURATIONS.find((d) => d.id === e.durationBucket) || {}).label || '') : ''}</span>
          <select data-act="cat" aria-label="분류">${catOpts(e.category)}</select>
          <input class="input slim" data-act="note" value="${esc(e.note)}" placeholder="메모" maxlength="80" />
          <button class="icon-btn" data-act="delete" aria-label="삭제">✕</button></li>`).join('')
      : '<li class="empty">아직 기록이 없어요. ⏱ 지금 탭에서 버튼을 눌러 보세요.</li>';
  }

  function onListAction(e) {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const ev = data.events.find((x) => x.id === li.dataset.id);
    if (!ev) return;
    const act = e.target.dataset.act;
    if (act === 'resolve') ev.resolved = e.target.checked;
    else if (act === 'cat') ev.category = e.target.value || null;
    else if (act === 'note') ev.note = e.target.value.trim();
    else if (act === 'delete') {
      if (!confirm('이 기록을 삭제할까요?')) return;
      data.events = data.events.filter((x) => x.id !== ev.id);
    } else return;
    persist();
    if (act !== 'note' && act !== 'cat') renderParking();
  }
  ['parkList', 'parkDoneList', 'logList'].forEach((id) => {
    $(id).addEventListener('change', onListAction);
    $(id).addEventListener('click', (e) => { if (e.target.dataset.act === 'delete') onListAction(e); });
  });

  // ---------- 렌더: 리포트 ----------
  $('demoBtn').addEventListener('click', () => { ui.demo = S.generateDemoData(Date.now()); renderReport(); });
  $('demoExit').addEventListener('click', () => { ui.demo = null; renderReport(); });

  function renderReport() {
    const src = ui.demo || data;
    const rd = S.readiness(data);
    const showReport = !!ui.demo || rd.ready;
    $('demoNotice').hidden = !ui.demo;
    $('reportPending').hidden = showReport;
    $('reportBody').hidden = !showReport;
    if (!showReport) {
      $('rpEvents').textContent = `${rd.events} / ${rd.needEvents}개`;
      $('rpDays').textContent = `${rd.days} / ${rd.needDays}일`;
      $('rpBar').style.width = `${Math.round(rd.progress * 100)}%`;
      return;
    }
    const r = S.buildReport(src);
    const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);
    const kpi = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    $('kpis').innerHTML = [
      kpi(r.total, `총 흔들림 (🅿️${r.parks} ↩️${r.rets})`),
      kpi(pct(r.parkRate), '주차 성공률'),
      kpi(S.fmtMin(r.medianSpanMs), '집중 지속 (중앙값)'),
      kpi(r.ratePerHour == null ? '-' : `${r.ratePerHour.toFixed(1)}회`, '세션 1시간당 흔들림'),
    ].join('');
    $('insights').innerHTML = r.insights.length
      ? r.insights.map((i) => `<div class="insight ${i.tone}"><b>${esc(i.title)}</b><p>${esc(i.body)}</p></div>`).join('')
      : '<p class="muted">아직 뚜렷한 패턴이 없어요. 기록이 더 쌓이면 다시 확인해 보세요.</p>';

    const maxRate = Math.max(0.0001, ...r.hours.map((h) => h.rate || 0));
    $('hourBars').innerHTML = r.hours.map((h) => `<div class="col" title="${h.hour}시 · ${h.rate == null ? '데이터 부족' : h.rate.toFixed(1) + '회/시간'}">
      <div class="bar ${h.rate == null ? 'na' : ''}" style="height:${h.rate == null ? 2 : Math.max(2, (h.rate / maxRate) * 100)}%"></div>
      <div class="lbl">${h.hour % 3 === 0 ? h.hour : ''}</div></div>`).join('');

    $('catBars').innerHTML = r.categories.length
      ? r.categories.map((c) => `<div class="cat-row"><span>${c.meta ? c.meta.emoji + ' ' + esc(c.meta.label) : esc(c.id)}</span>
          <div class="track"><div class="fill" style="width:${Math.round(c.share * 100)}%"></div></div>
          <span class="n">${Math.round(c.share * 100)}%</span></div>`).join('') +
        (r.uncategorized ? `<p class="muted small">분류 안 된 기록 ${r.uncategorized}개는 제외했어요.</p>` : '')
      : '<p class="muted small">분류된 기록이 없어요. 정리함에서 분류해 보세요.</p>';

    const maxW = Math.max(1, ...r.weekday);
    $('weekBars').innerHTML = r.weekday.map((n, i) => `<div class="col" title="${S.WEEKDAYS[i]} · ${n}회">
      <div class="bar" style="height:${(n / maxW) * 85}%"></div>${S.WEEKDAYS[i]}</div>`).join('');
  }

  // ---------- 내보내기 / 가져오기 ----------
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  const stamp = () => S.dateKey(Date.now());
  $('exportCsv').addEventListener('click', () => download(`focus-log-${stamp()}.csv`, Store.toCSV(data), 'text/csv;charset=utf-8'));
  $('exportJson').addEventListener('click', () => download(`focus-backup-${stamp()}.json`, Store.toJSON(data), 'application/json'));
  $('importJson').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const next = Store.fromJSON(await f.text());
      if (!confirm(`기록 ${next.events.length}개, 세션 ${next.sessions.length}개를 불러옵니다. 현재 데이터는 대체돼요. 계속할까요?`)) return;
      data = next;
      persist();
      renderAll();
    } catch (err) {
      alert('가져오기 실패: ' + err.message);
    }
  });

  // ---------- 전체 렌더 ----------
  function renderTab() {
    if (activeSession() && ui.tab !== 'now') return; // 잠금 중엔 그리지도 않음
    if (ui.tab === 'tracker') renderTracker();
    else if (ui.tab === 'parking') renderParking();
    else if (ui.tab === 'report') renderReport();
  }
  function renderAll() {
    applyLock();
    renderNow();
    renderTab();
  }

  // 다른 탭/창에서 데이터가 바뀌면 동기화
  window.addEventListener('storage', (e) => {
    if (e.key !== Store.KEY) return;
    data = Store.load(storage).data;
    renderAll();
  });

  renderAll();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

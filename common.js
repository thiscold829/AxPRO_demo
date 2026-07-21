/**********************************************************************
 * AxPRO v2 — 클라이언트 공용 게이트웨이 (common.js)
 * ------------------------------------------------------------------
 * 데이터 안전 계층:
 *  - 읽기: 게이트웨이 JSON (CSV 파싱 없음). 실패 시 절대 빈 화면 렌더 X
 *          → localStorage 캐시(마지막 정상본) + 오프라인 배너.
 *  - 쓰기: 행단위 op 를 localStorage 아웃박스에 영속 → 순차 전송 →
 *          지수 백오프 재시도 → 브라우저 재시작 후 자동 이어전송.
 *  - 서버 응답을 실제 파싱 (applied 일 때만 큐에서 제거).
 *  - conflict = 서버본으로 갱신(타인 데이터 보호) + 알림.
 *  - opId 멱등성으로 재시도가 중복 저장 안 됨.
 **********************************************************************/
(function (global) {
  var CFG = global.AX_CONFIG || { API_URL: '' };
  var API_URL = (CFG.API_URL || '').trim();
  var CONFIGURED = !!API_URL;                // config.js 에 API_URL 이 설정됐는지

  var LS = {
    token:   'ax_token',
    user:    'ax_user',
    outbox:  'ax_outbox',
    cache:   'ax_cache_'      // + sheet
  };

  // ── 상태 관찰 ────────────────────────────────────────────────
  var statusListeners = [];
  var STATE = { phase: 'idle', pending: 0, offline: false };
  function setState(patch) {
    Object.assign(STATE, patch);
    statusListeners.forEach(function (cb) { try { cb(Object.assign({}, STATE)); } catch (e) {} });
  }

  // ── 세션/유저 ────────────────────────────────────────────────
  function token() { return sessionStorage.getItem(LS.token) || ''; }
  function user()  { try { return JSON.parse(sessionStorage.getItem(LS.user) || 'null'); } catch (e) { return null; } }
  function isManager() { var u = user(); return !!(u && u.manager); }
  // 총괄관리자 = role/직급에 '(admin)' 표기(또는 '관리자'). 설정(과제·구성원) 접근 전용
  function isAdmin() { var u = user(); return !!(u && (u.admin || /\(admin\)|관리자/i.test(String(u.role||'') + ' ' + String(u.rank||'')))); }

  // ── 저수준 fetch (text/plain 단순요청 → 프리플라이트 회피) ──
  function post(bodyObj, timeoutMs) {
    if (!CONFIGURED) return Promise.reject(new Error('API_URL 미설정 — config.js 를 설정하세요.'));
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, timeoutMs || 15000);
    return fetch(API_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(bodyObj),
      signal: ctl.signal
    }).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function (e) { clearTimeout(t); throw e; });
  }

  // ── 인증 ─────────────────────────────────────────────────────
  function login(name, pin) {
    return post({ action: 'login', name: name, pin: pin }, 15000).then(function (res) {
      if (res && res.ok) {
        sessionStorage.setItem(LS.token, res.token);
        sessionStorage.setItem(LS.user, JSON.stringify(res.user));
      }
      return res;
    });
  }
  function logout() { sessionStorage.removeItem(LS.token); sessionStorage.removeItem(LS.user); }
  function requireAuth() {
    if (!token()) { location.replace('index.html'); return false; }
    return true;
  }

  // ── 읽기 ─────────────────────────────────────────────────────
  // 성공: {entries, projects, members}. 실패: 캐시 폴백 + throwOnStale 정보.
  function pull(sheets) {
    sheets = sheets || ['entries', 'projects', 'members'];
    return post({ action: 'pull', token: token(), sheets: sheets }, 20000)
      .then(function (res) {
        if (!res || !res.ok) {
          if (res && res.code === 'AUTH') { logout(); location.replace('index.html'); throw new Error('auth'); }
          throw new Error((res && res.error) || 'pull failed');
        }
        // 마지막 정상본 캐시
        sheets.forEach(function (s) {
          if (res.data[s]) localStorage.setItem(LS.cache + s, JSON.stringify(res.data[s]));
        });
        setState({ offline: false });
        return { data: res.data, fromCache: false };
      })
      .catch(function (e) {
        // 실패 → 절대 빈 데이터 반환 금지. 캐시로 폴백.
        var data = {}, hasCache = false;
        sheets.forEach(function (s) {
          var raw = localStorage.getItem(LS.cache + s);
          if (raw) { try { data[s] = JSON.parse(raw); hasCache = true; } catch (_) { data[s] = []; } }
          else { data[s] = []; }
        });
        setState({ offline: true });
        return { data: data, fromCache: true, hasCache: hasCache, error: String(e) };
      });
  }

  // 마지막 정상본 캐시를 동기적으로 즉시 반환 (네트워크 대기 없이 화면 먼저 그리기)
  function cached(sheets) {
    sheets = sheets || ['entries', 'projects', 'members'];
    var data = {}, has = false;
    sheets.forEach(function (s) {
      var raw = localStorage.getItem(LS.cache + s);
      if (raw) { try { data[s] = JSON.parse(raw); has = true; } catch (_) { data[s] = []; } }
      else { data[s] = []; }
    });
    return { data: data, hasCache: has };
  }

  // ── 쓰기 (아웃박스) ──────────────────────────────────────────
  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function readOutbox() { try { return JSON.parse(localStorage.getItem(LS.outbox) || '[]'); } catch (e) { return []; } }
  function writeOutbox(q) { localStorage.setItem(LS.outbox, JSON.stringify(q)); setState({ pending: q.length }); }

  // op: {sheet, type:'upsert'|'delete', id, baseRev, fields}
  function enqueue(op) {
    op.opId = uuid();
    var q = readOutbox();
    q.push(op);
    writeOutbox(q);
    drain();
    return op.opId;
  }

  var draining = false;
  var applyCb = null;               // 페이지가 결과를 로컬에 반영하도록 등록
  function onApply(cb) { applyCb = cb; }

  function backoff(n) { return Math.min(30000, 800 * Math.pow(2, n)) + Math.floor(Math.random() * 400); }

  function drain() {
    if (draining) return Promise.resolve();
    if (!token() || !CONFIGURED) return Promise.resolve();
    draining = true;
    var fails = 0;

    function step() {
      var q = readOutbox();
      if (!q.length) { draining = false; setState({ phase: 'synced', pending: 0 }); return Promise.resolve(); }

      // 같은 시트끼리 앞에서부터 한 배치(최대 25). 같은 id 는 한 배치에 하나만(자기충돌 방지)
      var sheet = q[0].sheet;
      var batch = [], idsInBatch = {};
      for (var i = 0; i < q.length && batch.length < 25; i++) {
        if (q[i].sheet !== sheet) continue;
        if (idsInBatch[q[i].id]) continue;      // 같은 id 후속 op 은 다음 배치로 미룸
        idsInBatch[q[i].id] = true; batch.push(q[i]);
      }
      setState({ phase: 'syncing', pending: q.length });

      var payload = {
        action: 'batch', token: token(), sheet: sheet,
        ops: batch.map(function (o) { return { opId: o.opId, type: o.type || 'upsert', id: o.id, baseRev: o.baseRev, fields: o.fields }; })
      };

      return post(payload, 15000).then(function (res) {
        if (!res || !res.ok) {
          if (res && res.code === 'AUTH') { logout(); location.replace('index.html'); throw new Error('auth'); }
          throw new Error((res && res.error) || 'batch failed');   // 서버 자체 실패 → 재시도
        }
        fails = 0;
        setState({ offline: false });
        var settled = {}, applied = {};
        (res.results || []).forEach(function (r) {
          settled[r.opId] = true;
          if (r.status === 'applied' && r.rev != null) applied[r.id] = r.rev;
          if (applyCb) { try { applyCb(sheet, r); } catch (e) {} }
        });
        // settled 된 op 만 제거 (conflict/applied/error 모두 종결)
        var remain = readOutbox().filter(function (o) { return !settled[o.opId]; });
        // 같은 id 후속 op 의 baseRev 를 방금 적용된 rev 로 재기준화 (거짓 충돌 방지)
        remain.forEach(function (o) { if (o.sheet === sheet && applied[o.id] != null) o.baseRev = applied[o.id]; });
        writeOutbox(remain);
        return step();
      }).catch(function (e) {
        fails += 1;
        setState({ offline: true, phase: 'retry', pending: readOutbox().length });
        return wait(backoff(fails)).then(function () {
          if (fails > 12) { draining = false; return; }   // 아웃박스는 유지 — 다음 트리거 때 재개
          return step();
        });
      });
    }
    return step();
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 온라인 복귀/주기적으로 드레인 재개
  global.addEventListener('online', function () { setState({ offline: false }); drain(); });
  setInterval(function () { if (readOutbox().length) drain(); }, 20000);
  global.addEventListener('beforeunload', function (e) {
    if (readOutbox().length) { e.preventDefault(); e.returnValue = '저장되지 않은 변경이 있습니다.'; return e.returnValue; }
  });

  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ── 공개 API ─────────────────────────────────────────────────
  global.AX = {
    configured: CONFIGURED,
    login: login, logout: logout, requireAuth: requireAuth,
    user: user, isManager: isManager, isAdmin: isAdmin, token: token,
    pull: pull, cached: cached, enqueue: enqueue, drain: drain, onApply: onApply,
    hasPending: function (sheet, id, exceptOpId) { return readOutbox().some(function (o) { return o.sheet === sheet && o.id === id && o.opId !== exceptOpId; }); },
    onStatus: function (cb) { statusListeners.push(cb); cb(Object.assign({}, STATE)); },
    state: function () { return Object.assign({}, STATE); },
    uuid: uuid, today: today
  };
})(window);

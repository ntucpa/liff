/* 永承事務所管理系統｜客戶端（LIFF，GitHub Pages）
 * 規格 V4.0.4 3.1、5.1、5.5、第六章、7.2、第十八章
 * - 所有授權判斷在後端；前端只顯示後端回傳的結果
 * - sessionToken 只存在記憶體（AC-98），ID Token 不保存
 * - 畫面文字一律以 textContent 輸出 */
(function () {
  'use strict';

  var C = window.YC_LIFF;
  var session = '';
  var invite = '';
  var state = null; // 文件中心狀態（後端 customerStatus）

  // LIFF 初始化前先保留網址參數（邀請連結的 invite 可能放在 liff.state 內）
  var initialInvite = readInvite(location.href);

  /* ---------- 共用 ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  function button(text, cls, onClick) { var b = el('button', { class: 'btn ' + (cls || ''), type: 'button' }, text); b.onclick = onClick; return b; }
  function view() { var a = $('app'); a.innerHTML = ''; window.scrollTo(0, 0); return a; }
  function fmtDate(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  function readInvite(href) {
    try {
      var q = new URL(href).searchParams;
      if (q.get('invite')) return q.get('invite');
      var st = q.get('liff.state');
      if (st) { var m = st.match(/[?&]invite=([0-9a-f]+)/); if (m) return m[1]; }
    } catch (e) {}
    return '';
  }
  function setTitle(t) { $('title').textContent = t; document.title = t; }

  var busyTimer = null;
  function busy(text) {
    $('busyText').textContent = text || '處理中…';
    $('busy').classList.remove('hidden');
    clearTimeout(busyTimer);
    busyTimer = setTimeout(function () { $('busyText').textContent = '連線較慢，請稍候…'; }, 8000);
  }
  function idle() { clearTimeout(busyTimer); $('busy').classList.add('hidden'); }

  /* ---------- 後端 API ---------- */
  var NET_ERR = '網路連線不穩定，請稍後再試一次。';

  function raw(action, data) {
    return fetch(C.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action }, data || {}))
    }).then(function (r) {
      if (!r.ok) throw { code: 'NETWORK', message: NET_ERR };
      return r.json().then(null, function () { throw { code: 'NETWORK', message: NET_ERR }; });
    }, function () { throw { code: 'NETWORK', message: NET_ERR }; }).then(function (r) {
      if (r.ok) return r.data;
      throw r.error || { code: 'INTERNAL', message: '系統忙碌中，請稍後再試' };
    });
  }

  /** 以 LIFF ID Token 建立 Session（7.2）；同時取得文件中心狀態 */
  function login() {
    var idToken = liff.getIDToken();
    if (!idToken) return Promise.reject({ code: 'AUTH_FAILED', message: '無法取得 LINE 登入資訊，請關閉後重新開啟。' });
    return raw('login', { idToken: idToken, invite: invite }).then(function (d) {
      session = d.sessionToken;
      state = d.status;
      return d;
    });
  }

  /** 需登入之動作：Session 逾時時自動重新登入後再試一次（AC-98） */
  function api(action, data) {
    return raw(action, Object.assign({ sessionToken: session }, data || {})).then(null, function (err) {
      if (err.code !== 'SESSION_EXPIRED') throw err;
      return login().then(function () { return raw(action, Object.assign({ sessionToken: session }, data || {})); });
    });
  }

  function showError(message) {
    var a = view();
    add(a, add(el('div', { class: 'card center' }),
      el('div', { style: 'font-size:36px' }, '⚠️'),
      el('p', {}, message || '系統忙碌中，請稍後再試'),
      button('重新整理', '', function () { location.reload(); })));
  }

  /* ---------- 文件中心（第十八章） ---------- */
  function renderHome() {
    setTitle('文件中心');
    var s = state;
    $('firm').textContent = s.firmName || '';
    var a = view();

    s.companies.forEach(function (c) {
      var card = add(el('div', { class: 'card' }), el('div', { class: 'company' }, c.name));
      if (c.suspended) add(card, el('div', { class: 'muted small' }, '已停止服務，仍可查看歷史文件'));
      add(card, el('div', { class: 'note' }, '下載時請使用 ' + c.maskedEmail + ' 登入 Google（此 Google 帳號即為日後下載文件使用的帳號）'));
      add(card, el('div', { class: 'info' }, '文件瀏覽與下載功能即將開放。現在您已經可以直接在 LINE 聊天室傳送照片或檔案給我們。'));
      add(a, card);
    });

    s.syncing.forEach(function (c) {
      add(a, add(el('div', { class: 'card' }),
        add(el('div', { class: 'company' }, c.name), el('span', { class: 'badge warn' }, '設定中')),
        el('div', { class: 'muted' }, '帳號設定中，請稍候。完成後會寄 Email 通知您。'),
        el('div', { class: 'muted small' }, 'Google 帳號：' + c.maskedEmail)));
    });

    s.pending.forEach(function (p) {
      var cancel = button('取消申請', 'ghost inline', function () {
        if (!confirm('確定取消「' + p.name + '」的綁定申請？')) return;
        busy('取消中…');
        api('cancelBinding', { bindingRequestId: p.bindingRequestId }).then(function (st) { idle(); state = st; renderHome(); },
          function (e) { idle(); alert(e.message); });
      });
      add(a, add(el('div', { class: 'card' }),
        add(el('div', { class: 'company' }, p.name), el('span', { class: 'badge' }, '審核中')),
        el('div', { class: 'muted' }, '您的綁定申請正在審核中，審核通過後會以 Email 通知您。'),
        el('div', { class: 'muted small' }, 'Google 帳號：' + p.maskedEmail + '｜申請日期：' + fmtDate(p.requestedAt)),
        cancel));
    });

    if (!s.companies.length && !s.syncing.length && !s.pending.length) {
      var empty = add(el('div', { class: 'card empty' }), el('div', { class: 'icon' }, s.canApplyTaxId ? '🏢' : 'ℹ️'), el('h2', {}, s.emptyMessage || ''));
      if (s.canApplyTaxId) {
        add(empty, el('div', { class: 'muted' }, '綁定公司後，您傳送的文件會自動存到您公司的資料夾，也可以在這裡查看與下載。'));
        add(empty, button('綁定公司', 'teal', function () { renderTaxId(); }));
      }
      add(a, empty);
    }

    add(a, el('div', { class: 'foot' }, '如需綁定其他公司、變更 Google 帳號或解除綁定，請聯絡事務所。'));
  }

  /* ---------- 綁定流程：統編 → 公司名稱 → Google 帳號 → 確認（5.1、5.5） ---------- */
  function steps(n) {
    var s = el('div', { class: 'steps' });
    for (var i = 1; i <= 3; i++) s.appendChild(el('span', { class: i <= n ? 'on' : '' }));
    return s;
  }

  function renderTaxId() {
    setTitle('綁定公司');
    var a = view();
    var input = el('input', { class: 'in taxid', type: 'tel', inputmode: 'numeric', maxlength: '8', placeholder: '8 碼數字', autocomplete: 'off' });
    var err = el('div', { class: 'err' });
    var next = button('查詢', '', function () {
      var v = input.value.replace(/\D/g, '');
      if (v.length !== 8) { err.textContent = '請輸入 8 碼統一編號'; return; }
      next.disabled = true; err.textContent = '';
      busy('查詢中…');
      api('lookupTaxId', { taxId: v }).then(function (d) {
        idle();
        renderEmail({ companyId: d.companyId, companyName: d.companyName, email: d.suggestedEmail, typoMap: d.typoMap, hasPending: d.hasPending });
      }, function (e) { idle(); next.disabled = false; err.textContent = e.message; });
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') next.click(); });
    add(a, add(el('div', { class: 'card' }), steps(1),
      el('h2', {}, '請輸入公司統一編號'),
      el('div', { class: 'muted' }, '系統會查出事務所登記的公司名稱，請確認是否正確。'),
      input, err, next,
      button('返回', 'link', function () { renderHome(); })));
    setTimeout(function () { input.focus(); }, 100);
  }

  /** ctx：{ companyId | invite, companyName, email, typoMap, hasPending } */
  function renderEmail(ctx) {
    setTitle(ctx.invite ? '邀請綁定' : '綁定公司');
    var a = view();
    var input = el('input', { class: 'in', type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'off', placeholder: 'name@gmail.com' });
    input.value = ctx.email || '';
    var err = el('div', { class: 'err' });
    var sug = el('div', { class: 'suggest hidden' });
    var next = button('下一步', '', function () {
      var email = normalizeEmail(input.value);
      if (!isValidEmail(email)) { err.textContent = 'Email 格式不正確，請重新輸入'; return; }
      err.textContent = '';
      var fix = suggestTypo(email, ctx.typoMap || {});
      if (!fix) return renderConfirm(ctx, email);
      // 5.5 網域錯字提示：僅提示，客戶可採用或維持原輸入
      sug.innerHTML = '';
      add(sug, el('div', {}, '您是不是要輸入：'), el('div', { style: 'font-weight:700;font-size:18px;word-break:break-all;margin:4px 0' }, fix),
        button('使用 ' + fix, 'teal', function () { renderConfirm(ctx, fix); }),
        button('維持原輸入（' + email + '）', 'ghost', function () { renderConfirm(ctx, email); }));
      sug.classList.remove('hidden');
    });
    var card = add(el('div', { class: 'card' }), steps(2),
      el('div', { class: 'muted' }, '公司名稱'),
      el('div', { class: 'company' }, ctx.companyName));
    if (ctx.hasPending) add(card, el('div', { class: 'note' }, '您已送出過此公司的申請，重新送出會取代原申請。'));
    add(card, el('label', { class: 'lbl' }, '您的 Google 帳號（Email）'), input,
      el('div', { class: 'muted small', style: 'margin-top:6px' }, '請填寫日後要用來下載文件的 Google 帳號（通常是 Gmail）。'),
      err, next, sug,
      button(ctx.invite ? '稍後再說' : '返回', 'link', function () { ctx.invite ? renderHome() : renderTaxId(); }));
    add(a, card);
  }

  function renderConfirm(ctx, email) {
    var a = view();
    var err = el('div', { class: 'err' });
    var ok = button('確認送出', 'teal', function () {
      ok.disabled = true; err.textContent = '';
      busy('送出中…');
      var data = ctx.invite ? { invite: ctx.invite, email: email } : { companyId: ctx.companyId, email: email };
      api('submitBinding', data).then(function (d) {
        idle();
        state = d.status;
        if (ctx.invite) invite = '';
        if (d.submitted) return renderDone(ctx, email);
        renderMessage(d.invite && d.invite.message);
      }, function (e) { idle(); ok.disabled = false; err.textContent = e.message; });
    });
    add(a, add(el('div', { class: 'card' }), steps(3),
      el('h2', {}, '請確認以下資料'),
      el('div', { class: 'muted' }, '公司名稱'),
      el('div', { class: 'company' }, ctx.companyName),
      el('div', { class: 'muted', style: 'margin-top:12px' }, 'Google 帳號'),
      el('div', { class: 'big' }, email),
      el('div', { class: 'note' }, '此 Google 帳號即為日後下載文件使用的帳號，請確認無誤。'),
      err, ok,
      button('返回修改', 'ghost', function () { ctx.email = email; renderEmail(ctx); })));
  }

  function renderDone(ctx, email) {
    setTitle('申請已送出');
    var a = view();
    add(a, add(el('div', { class: 'card center' }),
      el('div', { style: 'font-size:44px' }, '✅'),
      el('h2', {}, '申請已送出'),
      el('p', {}, '「' + ctx.companyName + '」的綁定申請已送出，事務所審核通過並完成設定後，會寄 Email 通知您：'),
      el('div', { class: 'big', style: 'font-size:18px' }, email),
      el('div', { class: 'info' }, '審核通過前，系統還無法處理您傳送的文件，請於收到核准通知後再傳送。'),
      button('返回文件中心', '', function () { renderHome(); })));
  }

  function renderMessage(message) {
    setTitle('文件中心');
    var a = view();
    add(a, add(el('div', { class: 'card center' }),
      el('div', { style: 'font-size:36px' }, 'ℹ️'),
      el('p', {}, message || ''),
      button('前往文件中心', '', function () { renderHome(); })));
  }

  /** 邀請連結開啟（第六章）：依後端判斷的狀態顯示 */
  function handleInvite(inv) {
    if (inv.state === 'OK') {
      return renderEmail({ invite: invite, companyName: inv.companyName, email: inv.suggestedEmail, typoMap: inv.typoMap });
    }
    invite = '';
    renderMessage(inv.message);
  }

  /* ---------- Email 輸入輔助（5.5；後端會再驗證一次） ---------- */
  function normalizeEmail(s) {
    return String(s || '').trim()
      .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[\s　]+/g, '').toLowerCase();
  }
  function isValidEmail(s) { return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(s); }
  function suggestTypo(email, map) {
    var at = email.lastIndexOf('@');
    var d = email.slice(at + 1);
    return map[d] ? email.slice(0, at + 1) + map[d] : '';
  }

  /* ---------- 啟動 ---------- */
  var slow = setTimeout(function () { var t = $('loadingText'); if (t) t.textContent = '連線較慢，請稍候…'; }, 8000);
  var initTimeout = setTimeout(function () { showError('LINE 載入逾時，請關閉後重新開啟。'); }, 20000);

  liff.init({ liffId: C.LIFF_ID }).then(function () {
    clearTimeout(initTimeout);
    if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
    invite = readInvite(location.href) || initialInvite;
    if (invite) history.replaceState({}, '', location.pathname);
    return login().then(function (d) {
      clearTimeout(slow);
      $('firm').textContent = d.status.firmName || '';
      if (d.invite) return handleInvite(d.invite);
      renderHome();
    });
  }).then(null, function (err) {
    clearTimeout(initTimeout); clearTimeout(slow);
    if (err && err.code === 'AUTH_FAILED') { try { if (!liff.isInClient()) liff.logout(); } catch (e) {} }
    showError(err && err.code === 'AUTH_FAILED' ? '登入已逾時，請關閉此頁面後重新開啟。' : (err && err.message) || 'LINE 載入失敗，請關閉後重新開啟。');
  });
})();

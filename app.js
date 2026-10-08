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
  var oaUrl = ''; // 官方帳號加入好友連結（登入時由後端提供）
  var state = null; // 文件中心狀態（後端 customerStatus）
  var homeJson = ''; // 目前畫面所用的首頁狀態
  var onHome = false; // 目前畫面是否為文件中心首頁
  var loginP = null; // 進行中的登入（先顯示上次畫面時，動作要等它完成）
  var CACHE_KEY = 'yc_home_v1';

  // LIFF 初始化前先保留網址參數（邀請連結的 invite 可能放在 liff.state 內）
  var initialInvite = readInvite(location.href);
  var initialPage = readParam(location.href, 'page');

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
  function view() { var a = $('app'); a.innerHTML = ''; window.scrollTo(0, 0); onHome = false; return a; }
  function fmtDate(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  function readParam(href, name) {
    try {
      var q = new URL(href).searchParams;
      if (q.get(name)) return q.get(name);
      var st = q.get('liff.state');
      if (st) { var m = st.match(new RegExp('[?&]' + name + '=([^&]+)')); if (m) return decodeURIComponent(m[1]); }
    } catch (e) {}
    return '';
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
    var p = raw('login', { idToken: idToken, invite: invite }).then(function (d) {
      session = d.sessionToken;
      state = d.status;
      if (d.oaUrl) oaUrl = d.oaUrl;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ state: d.status, oaUrl: d.oaUrl || '' })); } catch (e) {}
      return d;
    });
    loginP = p.then(function () {}, function () {});
    return p;
  }

  /** 快速通道：向 Cloudflare 問（比 Apps Script 快很多）。回傳 { ok, data } 或 { ok:false, error }；連線失敗或回「不確定」(FALLBACK) 一律回 null，由原本的流程處理 */
  function fast(action, extra) {
    var idToken = liff.getIDToken();
    if (!C.FAST_URL || !idToken) return Promise.resolve(null);
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
    return fetch(C.FAST_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctl ? ctl.signal : undefined,
      body: JSON.stringify(Object.assign({ action: action, idToken: idToken }, extra || {}))
    }).then(function (r) { return r.json(); }).then(function (r) {
      clearTimeout(timer);
      if (r && r.ok && r.data) return r;
      if (r && r.error && r.error.code && r.error.code !== 'FALLBACK' && r.error.code !== 'BAD_REQUEST') return r;
      return null;
    }, function () { clearTimeout(timer); return null; });
  }
  /** 先問快速通道，沒有答案（或不確定）才問 Apps Script */
  function apiFast(fastAction, gasAction, data) {
    return fast(fastAction, data).then(function (f) {
      if (f && f.ok) return f.data;
      if (f) throw f.error;
      return api(gasAction, data);
    });
  }
  function fastStatus() { return fast('loginFast').then(function (r) { return r && r.ok && r.data.status ? r.data : null; }); }

  /** 需登入之動作：Session 逾時時自動重新登入後再試一次（AC-98） */
  function api(action, data) {
    var first = session ? Promise.resolve() : (loginP || Promise.resolve());
    return first.then(function () { return raw(action, Object.assign({ sessionToken: session }, data || {})); }).then(null, function (err) {
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
    homeJson = JSON.stringify(s);
    $('firm').textContent = s.firmName || '';
    var a = view();
    onHome = true;

    if (s.unclassifiedCount) {
      var un = add(el('div', { class: 'card', style: 'border-color:#e8c36a;background:#fffaf0' }),
        el('div', { style: 'font-weight:700' }, '您有 ' + s.unclassifiedCount + ' 份文件尚未分類'),
        button('前往分類', 'teal', function () { renderClassify(); }));
      add(a, un);
    }
    s.companies.forEach(function (c) {
      var card = add(el('div', { class: 'card tap' }), el('div', { class: 'company' }, c.name));
      if (c.suspended) add(card, el('div', { class: 'muted small' }, '已停止服務，仍可查看歷史文件'));
      add(card, el('div', { class: 'note' }, '下載時請使用 ' + c.maskedEmail + ' 登入 Google（此 Google 帳號即為日後下載文件使用的帳號）'));
      add(card, button('查看文件', '', function () { renderBrowse(c, ''); }));
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
      add(a, oaCard('沒有加入官方帳號，就收不到事務所傳來的通知與訊息。'));
    }

    add(a, el('div', { class: 'foot' }, '如需綁定其他公司、變更 Google 帳號或解除綁定，請聯絡事務所。'));
  }

  /* ---------- 瀏覽公司資料夾與下載（契約第 1～9 項） ---------- */
  function fmtSize(n) {
    if (n === null || n === undefined) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtDateTime(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var p = function (n) { return ('0' + n).slice(-2); };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fileIcon(name) {
    var e = String(name).split('.').pop().toLowerCase();
    if (e === 'pdf') return '📕';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].indexOf(e) >= 0) return '🖼️';
    if (['xls', 'xlsx', 'csv'].indexOf(e) >= 0) return '📗';
    if (['doc', 'docx'].indexOf(e) >= 0) return '📘';
    return '📄';
  }

  var browseHelp = null;
  var browseHelp = null;
  function renderBrowse(company, folderId) {
    setTitle(company.name);
    var a = view();
    add(a, button('‹ 回文件中心', 'link', function () { renderHome(); }));
    var box = add(el('div', { class: 'card' }), el('div', { class: 'muted' }, '載入中…'));
    add(a, box);
    apiFast('listFolderFast', 'listFolder', { companyId: company.companyId, folderId: folderId || '' }).then(function (d) {
      box.innerHTML = '';
      var head = add(el('div', {}), el('div', { class: 'company' }, d.folder.isRoot ? d.companyName : d.folder.name));
      if (!d.folder.isRoot) {
        add(head, button('‹ 回上一層', 'ghost inline', function () { renderBrowse(company, d.folder.parentId); }));
      }
      add(box, head);
      add(box, el('div', { class: 'note' }, '下載時請使用 ' + company.maskedEmail + ' 登入 Google（此 Google 帳號即為日後下載文件使用的帳號）'));
      // 多帳號說明：出現 403 或「需要存取權」時的處理步驟（點檔案後會自動展開）
      browseHelp = el('details', { class: 'muted small', style: 'margin-top:8px' });
      add(browseHelp, el('summary', { style: 'cursor:pointer' }, '下載時出現「您必須擁有權限」、403 或「需要存取權」？'),
        el('div', { style: 'margin-top:6px;line-height:1.7' }, '代表手機目前登入的是別的 Google 帳號，不是檔案有問題。請依序：'),
        el('div', { style: 'line-height:1.7' }, '方法一：畫面上有「切換帳戶」按鈕時，點它並選擇 ' + company.maskedEmail + '，就會直接打開檔案。'),
        el('div', { style: 'line-height:1.7' }, '方法二：沒有按鈕時（例如只顯示 403）——'),
        el('div', { style: 'line-height:1.7' }, '1. 用手機瀏覽器（iPhone 用 Safari，Android 用 Chrome）開啟 Google 登入頁。'),
        el('div', { style: 'line-height:1.7' }, '2. 登入或切換成 ' + company.maskedEmail + '。'),
        el('div', { style: 'line-height:1.7' }, '3. 回到這裡再點一次檔案。'),
        button('開啟 Google 登入頁', 'ghost inline', function () {
          var u = 'https://accounts.google.com';
          if (liff.isInClient()) liff.openWindow({ url: u, external: true }); else window.open(u, '_blank');
        }));
      add(box, browseHelp);
      if (!d.items.length) add(box, el('div', { class: 'muted', style: 'margin-top:12px' }, '這個資料夾目前沒有文件。'));
      var list = add(el('div', { class: 'files' }));
      d.items.forEach(function (it) {
        var row = el('div', { class: 'frow' });
        var icon = el('div', { class: 'ficon' }, it.isFolder ? '📁' : fileIcon(it.name));
        if (it.thumb) { // 縮圖載入失敗（過期或被擋）時自動換回圖示
          var img = el('img', { src: it.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
          img.onerror = function () { icon.textContent = fileIcon(it.name); };
          icon.textContent = '';
          icon.appendChild(img);
        }
        add(row, icon,
          add(el('div', { class: 'fmain' }), el('div', { class: 'fname' }, it.name),
            el('div', { class: 'muted small' }, it.isFolder ? '資料夾' : [fmtDateTime(it.modifiedTime), fmtSize(it.size)].filter(String).join('　'))));
        row.onclick = function () { it.isFolder ? renderBrowse(company, it.id) : openFile(company, it); };
        add(list, row);
      });
      add(box, list);
      if (d.truncated) add(box, el('div', { class: 'muted small', style: 'margin-top:8px' }, '文件較多，僅顯示前 300 筆。'));
    }, function (e) {
      box.innerHTML = '';
      add(box, el('div', { class: 'err' }, e.message));
      add(box, button('重新整理', 'ghost inline', function () { renderBrowse(company, folderId); }));
    });
  }

  /** 契約第 5 項：LINE 內以外部瀏覽器開啟；外部瀏覽器則先同步開新分頁再設定網址（避免被封鎖） */
  function openFile(company, it) {
    var win = null;
    if (!liff.isInClient()) { try { win = window.open('about:blank', '_blank'); } catch (e) {} }
    busy('取得文件連結…');
    apiFast('getFileUrlFast', 'getFileUrl', { companyId: company.companyId, fileId: it.id }).then(function (r) {
      idle();
      if (browseHelp) browseHelp.open = true; // 回到文件中心時，若開啟後出現 403，可直接看到處理步驟
      if (liff.isInClient()) liff.openWindow({ url: r.url, external: true });
      else if (win) win.location.href = r.url;
      else window.open(r.url, '_blank');
    }, function (e) { idle(); if (win) win.close(); alert(e.message); });
  }

  /* ---------- 文件分類（9.5） ---------- */
  function renderClassify() {
    setTitle('文件分類');
    var a = view();
    add(a, button('‹ 回文件中心', 'link', function () { renderHome(); }));
    var box = add(el('div', {}), add(el('div', { class: 'card' }), el('div', { class: 'muted' }, '載入中…')));
    add(a, box);
    api('getClassify', {}).then(function (d) { drawClassify(box, d); }, function (e) {
      box.innerHTML = ''; add(box, add(el('div', { class: 'card' }), el('div', { class: 'err' }, e.message)));
    });
  }

  function drawClassify(box, d) {
    box.innerHTML = '';
    if (!d.pendingCount && d.preparingCount) {
      add(box, add(el('div', { class: 'card empty' }), el('div', { class: 'icon' }, '⏳'), el('h2', {}, '文件整理中，請稍候再開啟此頁'),
        el('div', { class: 'muted' }, '您傳送的 ' + d.preparingCount + ' 份文件正在整理。上班時段約 2～3 分鐘，其他時間最長約 15～20 分鐘。'),
        button('重新整理', 'teal', function () { renderClassify(); }),
        button('回文件中心', 'ghost', function () { renderHome(); })));
      return;
    }
    if (!d.pendingCount) {
      add(box, add(el('div', { class: 'card empty' }), el('div', { class: 'icon' }, '✅'), el('h2', {}, '目前沒有需要分類的文件'),
        button('回文件中心', '', function () { renderHome(); })));
      return;
    }
    if (!d.companies.length) {
      add(box, add(el('div', { class: 'card' }), el('div', { class: 'note' }, '目前沒有可用的公司綁定，請重新綁定後再分類。如有疑問請聯絡事務所。')));
      return;
    }
    var chosen = {}; // itemId → true
    var company = { value: '' };
    if (d.companies.length === 1) company.value = d.companies[0].companyId;

    add(box, add(el('div', { class: 'card' }), el('h2', {}, '請選擇每份文件屬於哪一家公司'),
      el('div', { class: 'muted' }, '勾選文件後，選擇公司並按「確認分類」。也可以只分類一部分，其餘稍後再處理。')));
    if (d.notReadyCount) add(box, el('div', { class: 'note' }, '有 ' + d.notReadyCount + ' 份文件整理中，請稍候再開啟此頁。（上班時段約 2～3 分鐘）'));

    var all = [];
    d.batches.forEach(function (b) {
      var card = add(el('div', { class: 'card' }), el('div', { class: 'muted small' }, fmtDateTime(b.createdAt) + ' 收到'));
      b.items.forEach(function (it) {
        var lb = el('label', { class: 'frow pick' });
        var cb = el('input', { type: 'checkbox' }); cb.disabled = !it.ready;
        cb.onchange = function () { if (cb.checked) chosen[it.itemId] = true; else delete chosen[it.itemId]; sync(); };
        all.push({ cb: cb, it: it });
        add(lb, cb, add(el('div', { class: 'fmain' }),
          el('div', { class: 'fname' }, '第 ' + it.seq + ' 份　' + (it.fileName || '照片')),
          el('div', { class: 'muted small' }, it.ready ? fmtDateTime(it.receivedAt) + ' 收到' : '文件整理中，請稍候再開啟此頁')));
        add(card, lb);
      });
      var bar = add(el('div', { style: 'margin-top:8px' }));
      add(bar, button('取消這批文件', 'link', function () {
        if (!confirm('確定取消這批文件？尚未分類的文件會被移除，之後需要請重新傳送。')) return;
        busy('取消中…');
        api('cancelBatch', { batchId: b.batchId }).then(function (r) { idle(); drawClassify(box, r); }, function (e) { idle(); alert(e.message); });
      }));
      add(box, card);
    });

    var pick = add(el('div', { class: 'card' }), el('label', { class: 'lbl', style: 'margin-top:0' }, '這些文件屬於'));
    var sel = el('select', { class: 'in', style: 'font-size:17px' });
    add(sel, el('option', { value: '' }, '請選擇公司'));
    d.companies.forEach(function (c) { add(sel, el('option', { value: c.companyId }, c.name)); });
    sel.value = company.value;
    sel.onchange = function () { company.value = sel.value; sync(); };
    var err = el('div', { class: 'err' });
    var go = button('確認分類', 'teal', function () {
      go.disabled = true; err.textContent = '';
      busy('分類中…');
      api('classify', { itemIds: Object.keys(chosen), companyId: company.value }).then(function (r) {
        idle(); drawClassify(box, r);
        var done = el('div', { class: 'info' }, '已送出分類。文件整理到公司資料夾，上班時段約 2～3 分鐘，其他時間最長約 15～20 分鐘。');
        box.insertBefore(done, box.firstChild);
      }, function (e) { idle(); go.disabled = false; err.textContent = e.message; });
    });
    var selAll = button('全選可分類的文件', 'ghost', function () {
      all.forEach(function (x) { if (!x.cb.disabled) { x.cb.checked = true; chosen[x.it.itemId] = true; } }); sync();
    });
    function sync() { go.disabled = !(company.value && Object.keys(chosen).length); go.textContent = '確認分類' + (Object.keys(chosen).length ? '（' + Object.keys(chosen).length + ' 份）' : ''); }
    add(pick, sel, selAll, err, go);
    add(box, pick);
    sync();
  }

  /* ---------- 使用說明（18.2；不需登入） ---------- */
  function renderGuide(info) {
    setTitle('使用說明');
    var a = view();
    var mb = info && info.MaxInboundFileSizeBytes ? Math.round(info.MaxInboundFileSizeBytes / 1048576) : 50;
    var sections = [
      ['📤 如何傳送文件', '直接在本聊天室傳送照片或檔案（例如 PDF），可以一次傳好幾份。傳送後會收到「已收到您傳送的文件」。\n影片與語音無法自動處理，請改傳照片或檔案，或聯絡事務所。\n單一檔案大小上限約 ' + mb + 'MB。'],
      ['🗂️ 如何分類文件（綁定多家公司的客戶）', '傳送後的回覆訊息會附「點此分類文件」按鈕，點開後為每份文件選擇所屬公司。\n上班時段文件整理約需 2～3 分鐘，下班時間最長約 15～20 分鐘；若畫面顯示「文件整理中」，請稍後再開啟。\n也可以從「文件中心」上方的未分類提示進入。'],
      ['📥 如何查看與下載文件', '點選單的「文件中心」→ 選擇公司與資料夾 → 點選檔案。下載時會開啟手機瀏覽器並進入 Google 頁面。'],
      ['🔑 下載時要用哪個 Google 帳號', '必須使用綁定時填寫的 Google 帳號（文件中心上方有顯示）。如果瀏覽器登入的是其他帳號，會看到需要存取權的畫面，請切換為綁定的帳號。'],
      ['🔐 看到 Google 登入畫面怎麼辦', '這是 Google 官方的登入頁面，請登入綁定的 Google 帳號。本系統不會在 LINE 內要求您輸入 Google 密碼。'],
      ['🏢 如何綁定公司、變更帳號或解除綁定', '首次使用請於文件中心點「綁定公司」並輸入統一編號。綁定其他公司，請聯絡事務所取得邀請連結。變更 Google 帳號或解除綁定，也請聯絡事務所。']
    ];
    sections.forEach(function (s) {
      var card = add(el('div', { class: 'card' }), el('h2', {}, s[0]));
      s[1].split('\n').forEach(function (line) { add(card, el('p', { style: 'margin:6px 0' }, line)); });
      add(a, card);
    });
    if (info && info.FirmName) {
      var c = add(el('div', { class: 'card' }), el('h2', {}, '☎️ 聯絡' + info.FirmName));
      [['電話', info.FirmPhone], ['地址', info.FirmAddress], ['服務時間', info.FirmServiceHours]].forEach(function (r) {
        if (r[1]) add(c, el('p', { style: 'margin:6px 0' }, r[0] + '：' + r[1]));
      });
      add(a, c);
    }
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
      fast('lookupTaxIdFast', { taxId: v }).then(function (f) {
        if (f && f.ok) return f.data;
        if (f) throw f.error; // 規則不符（格式、已綁定、查無公司…）：直接顯示原因
        return api('lookupTaxId', { taxId: v });
      }).then(function (d) {
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

  /** 「請先加入官方帳號」提示卡：已是好友（liff.getFriendship）就不顯示；查不到好友狀態時一律顯示 */
  function oaCard(text) {
    if (!oaUrl) return null;
    var box = el('div', { class: 'card center', style: 'border:2px solid #06C755' });
    add(box, el('div', { style: 'font-weight:700;margin-bottom:6px' }, '請先加入官方帳號'),
      el('div', { class: 'muted small', style: 'margin-bottom:8px' }, text || '沒有加入官方帳號，就收不到事務所傳來的通知與訊息，也找不到傳檔的對話。'),
      button('加入官方帳號', 'teal', function () { try { liff.openWindow({ url: oaUrl, external: false }); } catch (e) { location.href = oaUrl; } }));
    try { liff.getFriendship().then(function (f) { if (f && f.friendFlag && box.parentNode) box.parentNode.removeChild(box); }, function () { /* 查不到就維持顯示 */ }); } catch (e) { /* 同上 */ }
    return box;
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
    add(a, oaCard(), card);
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
    add(a, oaCard('請務必加入官方帳號，審核通過後的通知與請款訊息才會傳到您的 LINE。'));
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

  // 先用上次的畫面：一打開就顯示文件中心（背景再登入更新），不用等後端回應
  var shown = false;
  if (!initialInvite && !initialPage) {
    try {
      var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && cached.state && cached.state.companies) {
        state = cached.state; if (cached.oaUrl) oaUrl = cached.oaUrl;
        renderHome(); shown = true;
      }
    } catch (e) {}
  }

  liff.init({ liffId: C.LIFF_ID }).then(function () {
    clearTimeout(initTimeout);
    var page = readParam(location.href, 'page') || initialPage;
    // 18.2：使用說明不需登入即可閱讀
    if (page === 'guide') {
      clearTimeout(slow);
      return raw('getPublicInfo', {}).then(function (info) { $('firm').textContent = info.FirmName || ''; renderGuide(info); },
        function () { renderGuide(null); });
    }
    if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
    invite = readInvite(location.href) || initialInvite;
    if (invite || page) history.replaceState({}, '', location.pathname);
    var gasDone = false, inviteShown = false;
    if (invite) {
      // 邀請連結：同時問快速通道，先顯示填 Email 的畫面；Apps Script 登入在背景完成，送出時才需要
      fast('loginFast', { invite: invite }).then(function (f) {
        if (!f || !f.ok || !f.data.invite || gasDone) return;
        if (f.data.oaUrl) oaUrl = f.data.oaUrl;
        clearTimeout(slow); inviteShown = true; handleInvite(f.data.invite);
      });
    } else if (!page) {
      // 同時問快速通道：它先回來就先顯示首頁，Apps Script 登入在背景完成（之後按需要 Session 的按鈕會自動等它）
      fastStatus().then(function (f) {
        if (!f || gasDone || (shown && !onHome)) return;
        var changed = JSON.stringify(f.status) !== JSON.stringify(state);
        state = f.status; if (f.oaUrl) oaUrl = f.oaUrl;
        clearTimeout(slow);
        if (changed || !shown) { renderHome(); shown = true; }
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ state: f.status, oaUrl: f.oaUrl || '' })); } catch (e) {}
      });
    }
    return login().then(function (d) {
      gasDone = true;
      clearTimeout(slow);
      try { sessionStorage.removeItem('yc_relogin'); } catch (e) {}
      $('firm').textContent = d.status.firmName || '';
      if (d.invite) { if (inviteShown) return; return handleInvite(d.invite); }
      if (page === 'classify') return renderClassify();
      if (shown && !onHome) return; // 使用者已進到別的畫面，不打斷
      if (shown && onHome && JSON.stringify(d.status) === homeJson) return; // 畫面已是最新，不重畫
      renderHome();
    });
  }).then(null, function (err) {
    clearTimeout(initTimeout); clearTimeout(slow);
    // 電腦瀏覽器的 LINE ID Token 約 1 小時過期：自動重新登入一次（LINE App 內由 LIFF 自行更新）
    if (err && err.code === 'AUTH_FAILED' && !liff.isInClient()) {
      var tried = false; try { tried = sessionStorage.getItem('yc_relogin') === '1'; sessionStorage.setItem('yc_relogin', '1'); } catch (e) {}
      if (!tried) { try { liff.logout(); } catch (e) {} liff.login({ redirectUri: location.href }); return; }
    }
    showError(err && err.code === 'AUTH_FAILED' ? '登入已逾時，請關閉此頁面後重新開啟。' : (err && err.message) || 'LINE 載入失敗，請關閉後重新開啟。');
  });
})();

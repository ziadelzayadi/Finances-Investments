/* My Spending - all app logic. Data never leaves the phone. */
(function () {
  'use strict';
  var P = window.SmsParser;
  var hasAndroid = typeof window.Android !== 'undefined';

  // ---------- Colors (validated categorical palette, fixed order) ----------
  var PALETTE = ['#257de0', '#f47230', '#00b894', '#f2a600', '#ee7fac', '#008a17', '#6a4ce2', '#ec4647'];
  var GRAY = '#9c9c9c';

  var KINDS = {
    need:   { label: 'Need',          hint: 'Essentials: food at home, bills, transport, health' },
    want:   { label: 'Want',          hint: 'Nice to have: eating out, shopping, fun' },
    other:  { label: 'Other spending', hint: 'Spending you do not want judged' },
    income: { label: 'Income',        hint: 'Salary, freelance, money you earned' },
    none:   { label: 'Not spending',  hint: 'Moving your own money, paying your credit card bill' }
  };
  var SPEND_KINDS = { need: 1, want: 1, other: 1 };

  var CARD_IDS = ['summary', 'health', 'categories', 'split', 'trend', 'daily', 'merchants'];
  var CARD_NAMES = {
    summary: 'Month summary', health: 'Healthy spending check', categories: 'Spending by category',
    split: 'Needs vs wants', trend: 'Last 6 months', daily: 'Day by day', merchants: 'Top places'
  };

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function defaultData() {
    var cats = [
      ['Groceries', 'need'], ['Food & dining', 'want'], ['Transport', 'need'], ['Bills', 'need'],
      ['Health', 'need'], ['Shopping', 'want'], ['Fun', 'want'], ['Cash', 'other'],
      ['Salary', 'income'], ['Freelance', 'income'], ['Own transfers', 'none']
    ];
    var spendIdx = 0;
    return {
      v: 1,
      categories: cats.map(function (c) {
        var color = SPEND_KINDS[c[1]] ? (PALETTE[spendIdx++] || GRAY) : GRAY;
        return { id: uid() + c[0].length, name: c[0], kind: c[1], budget: 0, color: color };
      }),
      rules: {},            // merchantKey -> categoryId
      tx: [],
      senders: {},          // sms sender -> { on: bool, count: n }
      settings: {
        rates: { USD: 48, EUR: 52, GBP: 61, SAR: 12.8, AED: 13 },
        startDay: 1,
        smallLimit: 300,
        lastSmsDate: 0,
        cards: CARD_IDS.slice(),
        hiddenCards: [],
        onboarded: false
      }
    };
  }

  // ---------- Storage ----------
  var D;
  function load() {
    var txt = '';
    try { txt = hasAndroid ? window.Android.loadData() : (localStorage.getItem('myspending') || ''); } catch (e) {}
    var d = null;
    try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = null; }
    D = migrate(d || defaultData());
  }
  function migrate(d) {
    var def = defaultData();
    d.categories = d.categories || def.categories;
    d.rules = d.rules || {};
    d.tx = d.tx || [];
    d.senders = d.senders || {};
    d.settings = Object.assign({}, def.settings, d.settings || {});
    d.settings.rates = Object.assign({}, def.settings.rates, d.settings.rates || {});
    CARD_IDS.forEach(function (c) { if (d.settings.cards.indexOf(c) < 0) d.settings.cards.push(c); });
    return d;
  }
  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 150);
  }
  function saveNow() {
    var json = JSON.stringify(D);
    var ok = true;
    try {
      if (hasAndroid) ok = window.Android.saveData(json);
      else localStorage.setItem('myspending', json);
    } catch (e) { ok = false; }
    if (ok === false) toast('Could not save. Please make a backup in Settings.');
  }

  // ---------- Helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n, dec) {
    if (!isFinite(n)) n = 0;
    var d = dec != null ? dec : (Math.abs(n) >= 1000 || Math.round(n) === n ? 0 : 2);
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function egpStr(n, dec) { return 'EGP ' + fmt(n, dec); }
  function curStr(n, cur) { return cur === 'USD' ? '$' + fmt(n) : cur + ' ' + fmt(n); }
  function rate(cur) { return cur === 'EGP' ? 1 : (+D.settings.rates[cur] || 0); }
  function egp(t) { return t.amount * rate(t.currency); }
  function usd(n) { var r = rate('USD'); return r ? n / r : 0; }
  function catById(id) { for (var i = 0; i < D.categories.length; i++) if (D.categories[i].id === id) return D.categories[i]; return null; }
  function senderOn(t) { if (t.manual) return true; var s = D.senders[t.sender]; return !s || s.on !== false; }
  function visibleTx() { return D.tx.filter(function (t) { return !t.hidden && senderOn(t); }); }
  function kindOf(t) { var c = catById(t.cat); return c ? c.kind : null; }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // A "month" can start on salary day (Settings). Period key = "YYYY-MM" of the start.
  function periodKey(ms) {
    var d = new Date(ms), sd = D.settings.startDay || 1;
    var y = d.getFullYear(), m = d.getMonth();
    if (d.getDate() < sd) { m--; if (m < 0) { m = 11; y--; } }
    return y + '-' + (m < 9 ? '0' : '') + (m + 1);
  }
  function periodStart(key) { var p = key.split('-'); return new Date(+p[0], +p[1] - 1, D.settings.startDay || 1); }
  function periodEnd(key) { var s = periodStart(key); return new Date(s.getFullYear(), s.getMonth() + 1, D.settings.startDay || 1); }
  function shiftKey(key, n) { var s = periodStart(key); return periodKey(new Date(s.getFullYear(), s.getMonth() + n, D.settings.startDay || 1).getTime()); }
  function periodLabel(key, short) {
    var s = periodStart(key);
    if ((D.settings.startDay || 1) === 1 || short) return MONTHS[s.getMonth()] + (short ? '' : ' ' + s.getFullYear());
    var e = new Date(periodEnd(key).getTime() - 864e5);
    return s.getDate() + ' ' + MONTHS[s.getMonth()] + ' – ' + e.getDate() + ' ' + MONTHS[e.getMonth()] + ' ' + e.getFullYear();
  }
  function dayLabel(ms) {
    var d = new Date(ms);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }
  function timeLabel(ms) { var d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  // Signed spending effect of a transaction (refunds in a spending category reduce it).
  function spendAmount(t) {
    var k = kindOf(t);
    if (k === null) return t.dir === 'out' ? egp(t) : 0;   // unsorted money out counts as spending
    if (!SPEND_KINDS[k]) return 0;
    return t.dir === 'out' ? egp(t) : -egp(t);
  }

  function monthStats(key) {
    var s = { spent: 0, income: 0, incomeUsd: 0, incomeEgpOnly: 0, unsortedIn: 0, unsorted: 0, byCat: {}, byKind: { need: 0, want: 0, other: 0, unsorted: 0 },
      byMerchant: {}, byDay: {}, smallCount: 0, smallSum: 0, count: 0 };
    visibleTx().forEach(function (t) {
      if (periodKey(t.date) !== key) return;
      s.count++;
      var k = kindOf(t);
      if (!t.cat) s.unsorted++;
      if (k === 'income' && t.dir === 'in') {
        s.income += egp(t);
        if (t.currency === 'USD') s.incomeUsd += t.amount; else s.incomeEgpOnly += egp(t);
        return;
      }
      if (k === null && t.dir === 'in') { s.unsortedIn += egp(t); return; }
      var a = spendAmount(t);
      if (!a) return;
      s.spent += a;
      var ck = t.cat || '_unsorted';
      s.byCat[ck] = (s.byCat[ck] || 0) + a;
      s.byKind[k || 'unsorted'] += a;
      var mk = t.merchant || '?';
      s.byMerchant[mk] = s.byMerchant[mk] || { sum: 0, n: 0 };
      s.byMerchant[mk].sum += a; s.byMerchant[mk].n++;
      var dd = new Date(t.date); var dk = dd.getFullYear() + '-' + dd.getMonth() + '-' + dd.getDate();
      s.byDay[dk] = (s.byDay[dk] || 0) + a;
      if (k === 'want' && t.dir === 'out' && egp(t) < (D.settings.smallLimit || 0)) { s.smallCount++; s.smallSum += egp(t); }
    });
    return s;
  }

  // Spending from the start of a period up to the same number of days in.
  function spentUntilDay(key, days) {
    var start = periodStart(key).getTime(), stop = start + days * 864e5, sum = 0;
    visibleTx().forEach(function (t) { if (t.date >= start && t.date < stop) sum += spendAmount(t); });
    return sum;
  }

  // ---------- UI state ----------
  var UI = { tab: 'home', month: null, txMode: 'all', search: '', sheetStack: 0, trendSel: null, daySel: null };
  var view = document.getElementById('view');

  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function unsortedCount() { return visibleTx().filter(function (t) { return !t.cat; }).length; }

  function render() {
    document.getElementById('month-label').textContent = periodLabel(UI.month);
    document.querySelector('.month-bar').style.visibility = (UI.tab === 'home' || UI.tab === 'tx') ? 'visible' : 'hidden';
    var n = unsortedCount(), b = document.getElementById('sort-badge');
    b.hidden = !n; b.textContent = n > 99 ? '99+' : n;
    [].forEach.call(document.querySelectorAll('#tabs button'), function (el) { el.classList.toggle('on', el.dataset.tab === UI.tab); });
    if (UI.tab === 'home') renderHome();
    else if (UI.tab === 'tx') renderTx();
    else if (UI.tab === 'cats') renderCats();
    else renderSettings();
  }

  // ---------- Home / dashboard ----------
  function renderHome() {
    if (!D.settings.onboarded) { view.innerHTML = welcomeHtml(); return; }
    var s = monthStats(UI.month);
    var html = '';
    if (s.unsorted) {
      html += '<div class="warn-note" style="margin-bottom:12px">' + s.unsorted + ' transaction' + (s.unsorted > 1 ? 's' : '') +
        ' this month still need a category. <a href="#" data-act="go-sort">Sort them now</a></div>';
    }
    D.settings.cards.forEach(function (c) {
      if (D.settings.hiddenCards.indexOf(c) >= 0) return;
      var f = CARD_RENDER[c]; if (f) html += f(s);
    });
    html += '<p class="center tiny muted">Rearrange or hide these cards in Settings &rsaquo; Dashboard.</p>';
    view.innerHTML = html;
  }

  function welcomeHtml() {
    var granted = hasAndroid && window.Android.hasSmsPermission();
    return '<div class="card welcome"><h1>Welcome to My Spending</h1>' +
      '<p>This app reads your CIB and NBE bank SMS on this phone and turns them into a spending dashboard.</p>' +
      '<div class="ok-note">Private by design: the app has <b>no internet permission</b>, so nothing ever leaves your phone.</div>' +
      '<ol class="small"><li>Allow SMS access (Android will ask you).</li><li>The app reads all your old bank SMS.</li><li>You sort each place into a category once. The app remembers it.</li></ol>' +
      (granted ? '<button class="btn block" data-act="first-scan">Read my bank SMS</button>'
               : '<button class="btn block" data-act="ask-sms">Allow SMS access</button>') +
      '<div class="btns"><button class="btn ghost block" data-act="restore">Restore from a backup file</button></div>' +
      (hasAndroid ? '' : '<p class="tiny muted">Preview mode in a browser: sample messages will be used.</p>') +
      '</div>';
  }

  var CARD_RENDER = {
    summary: function (s) {
      var left = s.income - s.spent;
      var incomeSub = s.incomeUsd ? '$' + fmt(s.incomeUsd) + (s.incomeEgpOnly ? ' + ' + egpStr(s.incomeEgpOnly, 0) : ' in dollars') : '≈ $' + fmt(usd(s.income), 0);
      return '<div class="card"><h2>Spent in ' + esc(periodLabel(UI.month)) + '<small>' + s.count + ' transactions</small></h2>' +
        '<div class="hero">' + egpStr(s.spent, 0) + '</div><div class="hero-sub">≈ $' + fmt(usd(s.spent), 0) + ' at ' + fmt(rate('USD'), 2) + ' EGP per $</div>' +
        '<div class="stats3">' +
        '<div class="stat"><div class="k">Money in</div><div class="v">' + egpStr(s.income, 0) + '</div><div class="v2">' + incomeSub + '</div></div>' +
        '<div class="stat"><div class="k">Left over</div><div class="v">' + (left < 0 ? '−' : '') + egpStr(Math.abs(left), 0) + '</div><div class="v2">≈ $' + fmt(usd(left), 0) + '</div></div>' +
        '<div class="stat"><div class="k">Per day</div><div class="v">' + egpStr(s.spent / daysElapsed(UI.month), 0) + '</div><div class="v2">average</div></div>' +
        '</div>' +
        (s.unsortedIn ? '<p class="tiny muted" style="margin:10px 0 0">' + egpStr(s.unsortedIn, 0) + ' came in but is not sorted yet, so it is not counted as income.</p>' : '') +
        '</div>';
    },
    health: function (s) {
      var items = healthChecks(s);
      return '<div class="card"><h2>Healthy spending check<small>' + esc(periodLabel(UI.month, true)) + '</small></h2>' +
        items.map(function (it) {
          var icon = { good: '✓', warn: '!', bad: '✕', info: 'i' }[it.level];
          var word = { good: 'Healthy', warn: 'Watch', bad: 'Unhealthy', info: 'Info' }[it.level];
          return '<div class="ind"><div class="dot ' + it.level + '">' + icon + '</div><div class="grow"><div class="t">' + esc(it.title) +
            '<span class="tag ' + it.level + '">' + word + '</span></div><div class="d">' + it.text + '</div></div></div>';
        }).join('') + '</div>';
    },
    categories: function (s) {
      var rows = Object.keys(s.byCat).map(function (id) { return { id: id, sum: s.byCat[id] }; })
        .filter(function (r) { return Math.abs(r.sum) > 0.004; })
        .sort(function (a, b) { return b.sum - a.sum; });
      // include categories that have a budget even with no spending
      D.categories.forEach(function (c) { if (c.budget > 0 && SPEND_KINDS[c.kind] && !s.byCat[c.id]) rows.push({ id: c.id, sum: 0 }); });
      if (!rows.length) return '<div class="card"><h2>Spending by category</h2><p class="muted small">No spending this month yet.</p></div>';
      var max = 0;
      rows.forEach(function (r) { var c = catById(r.id); max = Math.max(max, r.sum, c && c.budget || 0); });
      return '<div class="card"><h2>Spending by category<small>% of total</small></h2>' + rows.map(function (r) {
        var c = catById(r.id);
        var name = c ? c.name : 'Not sorted yet', color = c ? c.color : GRAY;
        var pct = s.spent > 0 ? Math.round(r.sum / s.spent * 100) : 0;
        var w = max > 0 ? Math.max(0, r.sum) / max * 100 : 0;
        var bud = c && c.budget > 0 ? c.budget : 0;
        var sub = '';
        if (bud) {
          var p = r.sum / bud;
          var lvl = p > 1 ? 'bad' : p > 0.85 ? 'warn' : 'good';
          sub = '<div class="sub">' + (p > 1 ? egpStr(r.sum - bud, 0) + ' over' : egpStr(bud - r.sum, 0) + ' left') + ' of ' + egpStr(bud, 0) +
            ' budget <span class="tag ' + lvl + '">' + Math.round(p * 100) + '%</span></div>';
        }
        return '<div class="cbar" data-act="cat-tx" data-id="' + esc(r.id) + '"><div class="top"><span class="n"><span class="sw" style="background:' + color + '"></span><span class="ellipsis">' + esc(name) +
          '</span></span><span><b>' + egpStr(r.sum, 0) + '</b> <span class="muted small">' + pct + '%</span></span></div>' +
          '<div class="track"><div class="fill" style="width:' + w.toFixed(1) + '%;background:' + color + '"></div>' +
          (bud ? '<div class="budget-mark" style="left:' + Math.min(99.5, bud / max * 100).toFixed(1) + '%"></div>' : '') + '</div>' + sub + '</div>';
      }).join('') + (rows.some(function (r) { var c = catById(r.id); return c && c.budget; }) ? '<p class="tiny muted" style="margin:6px 0 0">The black tick on a bar is that category\'s monthly budget.</p>' : '') + '</div>';
    },
    split: function (s) {
      var parts = [['need', 'Needs', '#257de0'], ['want', 'Wants', '#f47230'], ['other', 'Other', '#00b894'], ['unsorted', 'Not sorted', GRAY]];
      var tot = parts.reduce(function (a, p) { return a + Math.max(0, s.byKind[p[0]]); }, 0);
      if (tot <= 0) return '';
      return '<div class="card"><h2>Needs vs wants</h2><div class="split">' + parts.map(function (p) {
        var v = Math.max(0, s.byKind[p[0]]); return v ? '<div style="flex:' + v + ';background:' + p[2] + '"></div>' : '';
      }).join('') + '</div><div class="legend">' + parts.filter(function (p) { return s.byKind[p[0]] > 0; }).map(function (p) {
        return '<span><span class="sw" style="background:' + p[2] + '"></span>' + p[1] + ' <b>' + Math.round(s.byKind[p[0]] / tot * 100) + '%</b> <span class="muted">' + egpStr(s.byKind[p[0]], 0) + '</span></span>';
      }).join('') + '</div></div>';
    },
    trend: function () {
      var keys = []; for (var i = 5; i >= 0; i--) keys.push(shiftKey(UI.month, -i));
      var vals = keys.map(function (k) { return monthStats(k).spent; });
      var max = Math.max.apply(null, vals.concat([1]));
      var sel = UI.trendSel != null ? UI.trendSel : 5;
      var avg = vals.slice(0, 5).filter(function (v) { return v > 0; });
      var avgV = avg.length ? avg.reduce(function (a, b) { return a + b; }, 0) / avg.length : 0;
      return '<div class="card"><h2>Last 6 months<small>total spent</small></h2><div class="cols">' + keys.map(function (k, i) {
        return '<div class="c' + (i === sel ? ' sel' : ' dim') + '" data-act="trend-sel" data-i="' + i + '"><div class="bar" style="height:' + (vals[i] / max * 100).toFixed(1) + '%"></div></div>';
      }).join('') + '</div><div class="xlab">' + keys.map(function (k) { return '<span>' + periodLabel(k, true) + '</span>'; }).join('') + '</div>' +
        '<div class="chart-cap"><b>' + esc(periodLabel(keys[sel])) + ':</b> ' + egpStr(vals[sel], 0) +
        (avgV ? ' · average of earlier months ' + egpStr(avgV, 0) : '') + '</div></div>';
    },
    daily: function (s) {
      var start = periodStart(UI.month), end = periodEnd(UI.month), days = [];
      for (var d = new Date(start); d < end; d.setDate(d.getDate() + 1)) days.push(new Date(d));
      var vals = days.map(function (d) { return Math.max(0, s.byDay[d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate()] || 0); });
      var max = Math.max.apply(null, vals.concat([1]));
      var sel = UI.daySel;
      var top = vals.indexOf(Math.max.apply(null, vals));
      var cap = sel != null ? dayLabel(days[sel].getTime()) + ': ' + egpStr(vals[sel], 0)
        : (vals[top] > 0 ? 'Biggest day: ' + dayLabel(days[top].getTime()) + ', ' + egpStr(vals[top], 0) + '. Tap a bar to see a day.' : 'No spending yet.');
      return '<div class="card"><h2>Day by day</h2><div class="cols daily">' + vals.map(function (v, i) {
        return '<div class="c' + (sel === i ? ' sel' : '') + '" data-act="day-sel" data-i="' + i + '"><div class="bar" style="height:' + (v / max * 100).toFixed(1) + '%"></div></div>';
      }).join('') + '</div><div class="xlab">' + days.map(function (d, i) {
        return '<span>' + (i === 0 || i === days.length - 1 || d.getDate() % 5 === 0 ? d.getDate() : '') + '</span>';
      }).join('') + '</div><div class="chart-cap">' + cap + '</div></div>';
    },
    merchants: function (s) {
      var rows = Object.keys(s.byMerchant).map(function (m) { return { m: m, sum: s.byMerchant[m].sum, n: s.byMerchant[m].n }; })
        .filter(function (r) { return r.sum > 0; }).sort(function (a, b) { return b.sum - a.sum; }).slice(0, 5);
      if (!rows.length) return '';
      return '<div class="card"><h2>Top places<small>where the money went</small></h2>' + rows.map(function (r) {
        return '<div class="list-item"><div class="grow"><div class="ellipsis">' + esc(r.m) + '</div><div class="tiny muted">' + r.n + ' time' + (r.n > 1 ? 's' : '') +
          '</div></div><div class="amt">' + egpStr(r.sum, 0) + '</div></div>';
      }).join('') + '</div>';
    }
  };

  function daysElapsed(key) {
    var s = periodStart(key).getTime(), e = periodEnd(key).getTime(), now = Date.now();
    var upto = Math.min(now, e);
    return Math.max(1, Math.ceil((upto - s) / 864e5));
  }
  function daysInPeriod(key) { return Math.round((periodEnd(key) - periodStart(key)) / 864e5); }

  function healthChecks(s) {
    var out = [];
    // 1. Savings rate
    if (s.income > 0) {
      var sr = (s.income - s.spent) / s.income;
      out.push({ title: 'Saving ' + Math.round(sr * 100) + '% of what came in',
        level: sr >= 0.2 ? 'good' : sr >= 0 ? 'warn' : 'bad',
        text: sr >= 0.2 ? 'Great. A common goal is to keep at least 20% of income.'
          : sr >= 0 ? 'Below the 20% goal. ' + egpStr(s.income * 0.2 - (s.income - s.spent), 0) + ' less spending would reach it.'
          : 'You spent ' + egpStr(s.spent - s.income, 0) + ' more than came in this month.' });
    } else {
      out.push({ title: 'No income sorted this month', level: 'info',
        text: 'Put your salary or freelance payments in an Income category to see how much you save.' });
    }
    // 2. Wants
    var base = s.income > 0 ? s.income : s.spent;
    if (base > 0 && s.byKind.want > 0) {
      var wp = s.byKind.want / base, limit = s.income > 0 ? 0.3 : 0.4;
      out.push({ title: 'Wants are ' + Math.round(wp * 100) + '% of your ' + (s.income > 0 ? 'income' : 'spending'),
        level: wp <= limit ? 'good' : wp <= limit + 0.1 ? 'warn' : 'bad',
        text: 'Guide: keep wants under ' + Math.round(limit * 100) + '% (the 50/30/20 rule). Wants this month: ' + egpStr(s.byKind.want, 0) + '.' });
    }
    // 3. Budgets
    var withBudget = D.categories.filter(function (c) { return c.budget > 0 && SPEND_KINDS[c.kind]; });
    if (withBudget.length) {
      var over = withBudget.filter(function (c) { return (s.byCat[c.id] || 0) > c.budget; });
      var near = withBudget.filter(function (c) { var v = s.byCat[c.id] || 0; return v <= c.budget && v > c.budget * 0.85; });
      out.push({ title: over.length ? over.length + ' budget' + (over.length > 1 ? 's' : '') + ' gone over' : near.length ? 'Close to a budget limit' : 'All budgets on track',
        level: over.length ? 'bad' : near.length ? 'warn' : 'good',
        text: over.length ? 'Over: ' + over.map(function (c) { return esc(c.name); }).join(', ') + '.'
          : near.length ? 'Above 85%: ' + near.map(function (c) { return esc(c.name); }).join(', ') + '.'
          : withBudget.length + ' categor' + (withBudget.length > 1 ? 'ies' : 'y') + ' with a budget, none over.' });
    } else {
      out.push({ title: 'No budgets set', level: 'info', text: 'Set a monthly budget on a category (Categories tab) to track it here.' });
    }
    // 4. Pace vs last month
    var isCurrent = UI.month === periodKey(Date.now());
    var days = isCurrent ? daysElapsed(UI.month) : daysInPeriod(UI.month);
    var prevKey = shiftKey(UI.month, -1);
    var prev = spentUntilDay(prevKey, days);
    if (prev > 0) {
      var ch = (s.spent - prev) / prev;
      out.push({ title: (ch >= 0 ? 'Spending ' + Math.round(ch * 100) + '% more' : 'Spending ' + Math.round(-ch * 100) + '% less') + ' than last month',
        level: ch <= 0.1 ? 'good' : ch <= 0.35 ? 'warn' : 'bad',
        text: 'Compared with the first ' + days + ' day' + (days > 1 ? 's' : '') + ' of ' + esc(periodLabel(prevKey)) + ' (' + egpStr(prev, 0) + ').' +
          (isCurrent ? ' At this pace the month ends near ' + egpStr(s.spent / days * daysInPeriod(UI.month), 0) + '.' : '') });
    }
    // 5. Small purchases
    if (s.smallCount) {
      out.push({ title: s.smallCount + ' small "want" purchases', level: s.smallCount >= 20 ? 'bad' : s.smallCount >= 10 ? 'warn' : 'good',
        text: 'Each under ' + egpStr(D.settings.smallLimit, 0) + ', together ' + egpStr(s.smallSum, 0) + '. Small buys add up quietly.' });
    }
    // 6. Unsorted
    if (s.unsorted) {
      out.push({ title: s.unsorted + ' not sorted yet', level: 'warn', text: 'These are counted as spending until you sort them. <a href="#" data-act="go-sort">Sort now</a>' });
    }
    return out;
  }

  // ---------- Transactions ----------
  function txMatches(t) {
    if (!UI.search) return true;
    var q = UI.search.toLowerCase(), c = catById(t.cat);
    return (t.merchant || '').toLowerCase().indexOf(q) >= 0 || (c && c.name.toLowerCase().indexOf(q) >= 0) ||
      (t.note || '').toLowerCase().indexOf(q) >= 0 || String(t.amount).indexOf(q) >= 0;
  }

  function renderTx() {
    var n = unsortedCount();
    var html = '<div class="seg"><button data-act="txmode" data-m="all" class="' + (UI.txMode === 'all' ? 'on' : '') + '">This month</button>' +
      '<button data-act="txmode" data-m="sort" class="' + (UI.txMode === 'sort' ? 'on' : '') + '">To sort (' + n + ')</button></div>';
    if (UI.txMode === 'sort') html += sortHtml();
    else {
      html += '<input class="search" type="search" placeholder="Search place, category, note" value="' + esc(UI.search) + '" data-input="search">';
      var list = visibleTx().filter(function (t) { return periodKey(t.date) === UI.month && txMatches(t); })
        .sort(function (a, b) { return b.date - a.date; });
      if (!list.length) html += '<div class="empty">No transactions in ' + esc(periodLabel(UI.month)) + '.</div>';
      var lastDay = '';
      html += '<div id="txlist">';
      list.forEach(function (t) {
        var dl = dayLabel(t.date);
        if (dl !== lastDay) { html += (lastDay ? '</div>' : '') + '<div class="day-h">' + dl + '</div><div class="card" style="padding:2px 12px">'; lastDay = dl; }
        html += txRow(t);
      });
      if (lastDay) html += '</div>';
      html += '</div>';
    }
    html += '<button class="fab" data-act="add-tx" aria-label="Add a cash transaction">+</button>';
    view.innerHTML = html;
  }

  function txRow(t) {
    var c = catById(t.cat);
    var amt = (t.dir === 'in' ? '+' : '−') + curStr(t.amount, t.currency);
    var sub = t.currency !== 'EGP' ? '<small>' + egpStr(egp(t), 0) + '</small>' : '';
    return '<div class="list-item" data-act="open-tx" data-id="' + esc(t.id) + '">' +
      '<span class="sw" style="background:' + (c ? c.color : '#ddd') + '"></span>' +
      '<div class="grow"><div class="ellipsis">' + esc(t.merchant) + '</div><div class="tiny muted">' +
      (c ? esc(c.name) : '<span class="chip sortme">Tap to sort</span>') + ' · ' + timeLabel(t.date) + ' · ' + esc(t.manual ? 'Cash / manual' : t.bank + (t.card ? ' ••' + t.card : '')) +
      '</div></div><div class="amt' + (t.dir === 'in' ? ' in' : '') + '">' + amt + sub + '</div></div>';
  }

  function unsortedGroups() {
    var g = {};
    visibleTx().forEach(function (t) {
      if (t.cat) return;
      var k = t.dir + '|' + P.merchantKey(t.merchant);
      if (!g[k]) g[k] = { key: k, merchant: t.merchant, dir: t.dir, n: 0, sum: 0, last: 0 };
      g[k].n++; g[k].sum += egp(t); g[k].last = Math.max(g[k].last, t.date);
    });
    return Object.keys(g).map(function (k) { return g[k]; }).sort(function (a, b) { return b.n - a.n || b.sum - a.sum; });
  }

  function sortHtml() {
    var groups = unsortedGroups();
    if (!groups.length) return '<div class="card empty">Everything is sorted. 🎉<br><span class="small">New bank SMS will show up here when a place is new.</span></div>';
    return '<p class="small muted" style="margin:2px 4px 10px">Grouped by place, all months. Pick a category once and every transaction from that place is sorted, now and in the future.</p>' +
      '<div class="card" style="padding:2px 12px">' + groups.map(function (g) {
        return '<div class="list-item" data-act="sort-group" data-key="' + esc(g.key) + '"><div class="grow"><div class="ellipsis"><b>' + esc(g.merchant) + '</b></div>' +
          '<div class="tiny muted">' + (g.dir === 'in' ? 'Money in' : 'Money out') + ' · ' + g.n + ' transaction' + (g.n > 1 ? 's' : '') + ' · last ' + dayLabel(g.last) + '</div></div>' +
          '<div class="amt' + (g.dir === 'in' ? ' in' : '') + '">' + egpStr(g.sum, 0) + '</div></div>';
      }).join('') + '</div>';
  }

  // ---------- Sheets ----------
  var sheetWrap = document.getElementById('sheet-wrap'), sheet = document.getElementById('sheet');
  var sheetCtx = null;
  function openSheet(html, ctx) { sheet.innerHTML = html; sheetWrap.hidden = false; sheetCtx = ctx || {}; sheet.scrollTop = 0; }
  function closeSheet() { sheetWrap.hidden = true; sheet.innerHTML = ''; sheetCtx = null; }

  function catChips(selected, filterDir) {
    var cats = D.categories.slice();
    // money in: show income first; money out: spending first
    cats.sort(function (a, b) {
      var ra = filterDir === 'in' ? (a.kind === 'income' ? 0 : 1) : (SPEND_KINDS[a.kind] ? 0 : 1);
      var rb = filterDir === 'in' ? (b.kind === 'income' ? 0 : 1) : (SPEND_KINDS[b.kind] ? 0 : 1);
      return ra - rb;
    });
    return '<div style="margin-top:10px">' + cats.map(function (c) {
      return '<button class="chip' + (c.id === selected ? ' on' : '') + '" data-act="pick-cat" data-id="' + c.id + '"><span class="sw" style="background:' + c.color + '"></span>' + esc(c.name) + '</button>';
    }).join('') + '<button class="chip" data-act="new-cat-inline">+ New category</button></div>';
  }

  function openSortGroup(key) {
    var g = unsortedGroups().filter(function (x) { return x.key === key; })[0];
    if (!g) return;
    openSheet('<h3>' + esc(g.merchant) + '</h3><div class="muted small">' + g.n + ' transaction' + (g.n > 1 ? 's' : '') + ', ' + egpStr(g.sum, 0) + ' in total · ' + (g.dir === 'in' ? 'money in' : 'money out') + '</div>' +
      catChips(null, g.dir) +
      '<label class="check"><input type="checkbox" id="remember" checked> Always put ' + esc(g.merchant) + ' in this category</label>' +
      '<div class="btns"><button class="btn ghost small" data-act="group-one-by-one" data-key="' + esc(key) + '">Sort them one by one instead</button></div>',
      { type: 'group', key: key, dir: g.dir });
  }

  function applyCategoryToGroup(key, catId, remember) {
    var n = 0, merchant = '';
    visibleTx().forEach(function (t) {
      if (!t.cat && (t.dir + '|' + P.merchantKey(t.merchant)) === key) { t.cat = catId; n++; merchant = t.merchant; }
    });
    if (remember && merchant) D.rules[ruleKey(key.split('|')[0], merchant)] = catId;
    save();
    toast(n + ' sorted into ' + (catById(catId) || {}).name);
  }

  function ruleKey(dir, merchant) { return dir + '|' + P.merchantKey(merchant); }

  function openTx(id) {
    var t = D.tx.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var c = catById(t.cat);
    openSheet('<h3>' + esc(t.merchant) + '</h3>' +
      '<div class="hero" style="font-size:26px;margin-top:6px">' + (t.dir === 'in' ? '+' : '−') + curStr(t.amount, t.currency) + '</div>' +
      (t.currency !== 'EGP' ? '<div class="hero-sub">= ' + egpStr(egp(t), 2) + ' at ' + fmt(rate(t.currency), 2) + ' EGP per ' + t.currency + ' (change the rate in Settings)</div>' : '') +
      '<div class="small muted" style="margin-top:6px">' + dayLabel(t.date) + ', ' + timeLabel(t.date) + ' · ' +
      esc(t.manual ? 'Added by you' : t.bank + (t.card ? ' card ••' + t.card : '') + (t.cardType === 'credit' ? ' (credit card)' : t.cardType === 'debit' ? ' (debit card)' : '')) + '</div>' +
      '<div style="margin-top:12px"><b class="small">Category</b>' + (c ? '' : ' <span class="chip sortme">not sorted</span>') + '</div>' +
      catChips(t.cat, t.dir) +
      '<label class="check"><input type="checkbox" id="remember" ' + (t.manual ? '' : 'checked') + '> Always put ' + esc(t.merchant) + ' in this category</label>' +
      '<label class="f">Note<input id="tx-note" value="' + esc(t.note || '') + '" placeholder="Optional"></label>' +
      (t.raw ? '<details><summary class="small muted">Original SMS</summary><div class="sms-raw">' + esc(t.raw) + '</div></details>' : '') +
      '<div class="btns">' + (t.cat ? '<button class="btn ghost small" data-act="uncat-tx">Mark as not sorted</button>' : '') +
      '<button class="btn ghost small" data-act="edit-tx">Fix amount / name</button>' +
      '<button class="btn danger small" data-act="del-tx">' + (t.manual ? 'Delete' : 'Hide this one') + '</button></div>',
      { type: 'tx', id: id });
  }

  function saveNoteFromSheet() {
    if (!sheetCtx || sheetCtx.type !== 'tx') return;
    var el = document.getElementById('tx-note'); if (!el) return;
    var t = txById(sheetCtx.id); if (t && (t.note || '') !== el.value) { t.note = el.value; save(); }
  }
  function txById(id) { return D.tx.filter(function (x) { return x.id === id; })[0]; }

  function openTxForm(t) {
    var isNew = !t;
    t = t || { dir: 'out', amount: '', currency: 'EGP', merchant: '', date: Date.now() };
    var d = new Date(t.date);
    var dv = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    var curs = ['EGP', 'USD', 'EUR', 'GBP', 'SAR', 'AED'];
    openSheet('<h3>' + (isNew ? 'Add a transaction' : 'Fix transaction') + '</h3>' +
      (isNew ? '<p class="small muted">For cash or anything without a bank SMS.</p>' : '') +
      '<div class="seg"><button data-act="form-dir" data-d="out" class="' + (t.dir === 'out' ? 'on' : '') + '">Money out</button><button data-act="form-dir" data-d="in" class="' + (t.dir === 'in' ? 'on' : '') + '">Money in</button></div>' +
      '<div class="row"><label class="f grow">Amount<input id="f-amount" inputmode="decimal" value="' + esc(t.amount) + '" placeholder="0"></label>' +
      '<label class="f" style="width:100px">Currency<select id="f-cur">' + curs.map(function (c) { return '<option' + (c === t.currency ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label></div>' +
      '<label class="f">Place / description<input id="f-merchant" value="' + esc(t.merchant) + '" placeholder="e.g. Fruit market"></label>' +
      '<label class="f">Date<input id="f-date" type="date" value="' + dv + '"></label>' +
      '<button class="btn block" data-act="save-form">Save</button>',
      { type: 'form', id: isNew ? null : t.id, dir: t.dir });
  }

  function saveForm() {
    var amount = P.parseNumber(document.getElementById('f-amount').value);
    if (!(amount > 0)) { toast('Please type an amount'); return; }
    var merchant = document.getElementById('f-merchant').value.trim() || (sheetCtx.dir === 'in' ? 'Money in' : 'Cash');
    var dv = document.getElementById('f-date').value;
    var parts = dv ? dv.split('-') : null;
    var now = new Date();
    var date = parts ? new Date(+parts[0], +parts[1] - 1, +parts[2], now.getHours(), now.getMinutes()).getTime() : Date.now();
    var cur = document.getElementById('f-cur').value;
    var t;
    if (sheetCtx.id) {
      t = txById(sheetCtx.id);
      t.amount = amount; t.currency = cur; t.merchant = merchant; t.date = date; t.dir = sheetCtx.dir; t.edited = true;
    } else {
      t = { id: 'm' + uid(), manual: true, dir: sheetCtx.dir, amount: amount, currency: cur, merchant: merchant, date: date, bank: '', card: '', cat: null };
      t.cat = D.rules[ruleKey(t.dir, merchant)] || null;
      D.tx.push(t);
    }
    save();
    UI.month = periodKey(date);
    openTx(t.id);
    render();
  }

  // ---------- Categories ----------
  function renderCats() {
    var groups = ['need', 'want', 'other', 'income', 'none'];
    var html = '<p class="small muted" style="margin:2px 4px 10px">Your categories. Tap one to rename it, change its type, or set a monthly budget. The type decides how the healthy spending check judges it.</p>';
    groups.forEach(function (k) {
      var list = D.categories.filter(function (c) { return c.kind === k; });
      html += '<div class="day-h">' + KINDS[k].label + '<span style="text-transform:none;font-weight:400"> · ' + KINDS[k].hint + '</span></div><div class="card" style="padding:2px 12px">';
      if (!list.length) html += '<div class="list-item muted small">None</div>';
      list.forEach(function (c) {
        var n = D.tx.filter(function (t) { return t.cat === c.id; }).length;
        html += '<div class="list-item" data-act="edit-cat" data-id="' + c.id + '"><span class="sw" style="background:' + c.color + '"></span><div class="grow">' + esc(c.name) +
          '<div class="tiny muted">' + n + ' transaction' + (n === 1 ? '' : 's') + (c.budget > 0 ? ' · budget ' + egpStr(c.budget, 0) + ' a month' : '') + '</div></div><span class="muted">&rsaquo;</span></div>';
      });
      html += '</div>';
    });
    html += '<button class="btn block" data-act="new-cat">+ Add a category</button>';
    var rules = Object.keys(D.rules);
    html += '<div class="day-h">Remembered places (' + rules.length + ')</div><div class="card" style="padding:2px 12px">';
    if (!rules.length) html += '<div class="list-item muted small">When you sort a place with "Always put…" ticked, it shows here.</div>';
    rules.sort().forEach(function (k) {
      var c = catById(D.rules[k]);
      var parts = k.split('|');
      html += '<div class="list-item"><div class="grow"><div class="ellipsis">' + esc(parts[1]) + '</div><div class="tiny muted">' + (parts[0] === 'in' ? 'Money in' : 'Money out') + ' → ' + esc(c ? c.name : 'deleted category') +
        '</div></div><button class="btn ghost small" data-act="del-rule" data-k="' + esc(k) + '">Forget</button></div>';
    });
    html += '</div>';
    view.innerHTML = html;
  }

  function openCatForm(c, fromPicker) {
    var isNew = !c;
    c = c || { name: '', kind: fromPicker === 'in' ? 'income' : 'want', budget: 0 };
    openSheet('<h3>' + (isNew ? 'New category' : 'Edit category') + '</h3>' +
      '<label class="f">Name<input id="c-name" value="' + esc(c.name) + '" placeholder="e.g. Coffee"></label>' +
      '<label class="f">Type<select id="c-kind">' + Object.keys(KINDS).map(function (k) {
        return '<option value="' + k + '"' + (k === c.kind ? ' selected' : '') + '>' + KINDS[k].label + ' – ' + KINDS[k].hint + '</option>';
      }).join('') + '</select></label>' +
      '<label class="f">Monthly budget in EGP (optional)<input id="c-budget" inputmode="decimal" value="' + (c.budget > 0 ? c.budget : '') + '" placeholder="No budget"></label>' +
      '<button class="btn block" data-act="save-cat">Save</button>' +
      (isNew ? '' : '<div class="btns"><button class="btn danger small" data-act="del-cat">Delete category</button></div>'),
      { type: 'cat', id: isNew ? null : c.id, back: fromPicker ? sheetCtx : null });
  }

  function nextColor(kind) {
    if (!SPEND_KINDS[kind]) return GRAY;
    var used = D.categories.map(function (c) { return c.color; });
    for (var i = 0; i < PALETTE.length; i++) if (used.indexOf(PALETTE[i]) < 0) return PALETTE[i];
    return GRAY;
  }

  function saveCat() {
    var name = document.getElementById('c-name').value.trim();
    if (!name) { toast('Please type a name'); return; }
    var kind = document.getElementById('c-kind').value;
    var b = P.parseNumber(document.getElementById('c-budget').value);
    var budget = b > 0 ? b : 0;
    var back = sheetCtx.back, c;
    if (sheetCtx.id) {
      c = catById(sheetCtx.id);
      if (SPEND_KINDS[kind] && !SPEND_KINDS[c.kind] && c.color === GRAY) c.color = nextColor(kind);
      c.name = name; c.kind = kind; c.budget = budget;
    } else {
      c = { id: uid(), name: name, kind: kind, budget: budget, color: nextColor(kind) };
      D.categories.push(c);
    }
    save();
    toast('Saved');
    if (back) {
      // return to the transaction / group the user was sorting, with the new category picked
      if (back.type === 'tx') { openTx(back.id); }
      else if (back.type === 'group') { openSortGroup(back.key); }
    } else closeSheet();
    render();
  }

  // ---------- Settings ----------
  function renderSettings() {
    var s = D.settings;
    var senders = Object.keys(D.senders).sort(function (a, b) { return D.senders[b].count - D.senders[a].count; });
    var html = '';
    html += '<div class="card"><h2>Exchange rates<small>you update these</small></h2>' +
      '<p class="small muted" style="margin-top:0">Dollar income and spending are shown in both USD and EGP using this rate.</p>' +
      ['USD', 'EUR', 'GBP', 'SAR', 'AED'].map(function (c) {
        return '<div class="toggle-row"><span>1 ' + c + ' =</span><span><input class="inline-input" inputmode="decimal" data-rate="' + c + '" value="' + (s.rates[c] || '') + '"> EGP</span></div>';
      }).join('') + '<button class="btn block" data-act="save-rates" style="margin-top:8px">Save rates</button></div>';

    html += '<div class="card"><h2>Bank SMS</h2>' +
      (hasAndroid && !window.Android.hasSmsPermission() ? '<div class="warn-note">SMS access is off. <a href="#" data-act="ask-sms">Turn it on</a></div>' : '') +
      '<p class="small muted" style="margin-top:0">Senders that sent transaction messages. Switch off any that are not your bank.</p>' +
      (senders.length ? senders.map(function (a) {
        return '<label class="toggle-row"><span>' + esc(a) + ' <span class="muted small">· ' + D.senders[a].count + ' transactions</span></span><input type="checkbox" data-sender="' + esc(a) + '"' + (D.senders[a].on !== false ? ' checked' : '') + ' style="width:22px;height:22px"></label>';
      }).join('') : '<p class="small">No bank messages read yet.</p>') +
      '<div class="btns"><button class="btn ghost small" data-act="scan-new">Check for new SMS</button><button class="btn ghost small" data-act="rescan-all">Re-read all SMS</button></div>' +
      '<p class="tiny muted">Re-read all adds anything missed (for example after switching a sender on). Your categories are kept.</p></div>';

    html += '<div class="card"><h2>Month</h2><div class="toggle-row"><span>My month starts on day</span><span><input class="inline-input" style="width:70px" inputmode="numeric" data-set="startDay" value="' + s.startDay + '"></span></div>' +
      '<p class="tiny muted">Use 1 for calendar months, or your salary day (for example 25) so each month runs salary to salary.</p>' +
      '<div class="toggle-row"><span>A "small purchase" is under</span><span>EGP <input class="inline-input" inputmode="decimal" data-set="smallLimit" value="' + s.smallLimit + '"></span></div></div>';

    html += '<div class="card"><h2>Dashboard<small>show, hide, reorder</small></h2>' + s.cards.map(function (c, i) {
      var on = s.hiddenCards.indexOf(c) < 0;
      return '<div class="toggle-row"><label class="row grow"><input type="checkbox" data-card="' + c + '"' + (on ? ' checked' : '') + ' style="width:22px;height:22px"> ' + CARD_NAMES[c] + '</label>' +
        '<span><button class="btn ghost small" data-act="card-up" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + '>▲</button> <button class="btn ghost small" data-act="card-down" data-i="' + i + '"' + (i === s.cards.length - 1 ? ' disabled' : '') + '>▼</button></span></div>';
    }).join('') + '</div>';

    html += '<div class="card"><h2>Backup</h2><p class="small muted" style="margin-top:0">Your data lives only inside this app. If you uninstall it or change phones, it is gone unless you keep a backup file. Save one to Google Drive or Downloads now and then.</p>' +
      '<div class="btns"><button class="btn small" data-act="backup">Save a backup file</button><button class="btn ghost small" data-act="restore">Restore from a file</button></div></div>';

    html += '<div class="card"><h2>Privacy</h2><p class="small" style="margin:0">This app has no internet permission. It reads SMS only on this phone and stores everything in its own private storage. ' +
      D.tx.length + ' transactions stored.</p><div class="btns"><button class="btn danger small" data-act="wipe">Erase all data in this app</button></div></div>';
    html += '<p class="center tiny muted">My Spending</p>';
    view.innerHTML = html;
  }

  // ---------- SMS reading ----------
  var SAMPLE = [
    ['NBE', 'تم خصم 670 جم من بطاقة الائتمان رقم 1111  عند PAYMOBMEAT PART يوم 11-25 الساعة 19:40 المتاح 1109.24 جم للمزيد اتصل ب 19623.', -1],
    ['CIB', 'تم خصم مبلغ  EGP 545.03 من بطاقة الخصم المباشر المنتهية بـ **2222 عند ZOOBA في 20/11/26 12:21 ، الرصيد المتاح 9813.78 EGP', -5],
    ['CIB', 'تم خصم مبلغ  EGP 1,240.50 من بطاقة الخصم المباشر المنتهية بـ **2222 عند CARREFOUR MAADI في 18/11/26 18:02 ، الرصيد المتاح 9000.00 EGP', -7],
    ['CIB', 'تم خصم مبلغ  EGP 85.00 من بطاقة الخصم المباشر المنتهية بـ **2222 عند UBER في 17/11/26 09:10 ، الرصيد المتاح 8900.00 EGP', -8],
    ['NBE', 'تم خصم 95 جم من بطاقة الائتمان رقم 1111  عند STARBUCKS يوم 11-15 الساعة 10:00 المتاح 1000 جم', -10],
    ['NBE', 'تم خصم 120 جم من بطاقة الائتمان رقم 1111  عند STARBUCKS يوم 11-12 الساعة 10:00 المتاح 1000 جم', -13],
    ['CIB', 'تم إضافة مبلغ USD 400.00 إلى حسابك رقم 3333 في 10/11/26 الرصيد المتاح USD 900.00', -15],
    ['CIB', 'تم خصم مبلغ  EGP 2,100.00 من بطاقة الخصم المباشر المنتهية بـ **2222 عند ZARA في 08/11/26 12:21 ، الرصيد المتاح 7000.00 EGP', -17],
    ['NBE', 'تم خصم 640 جم من بطاقة الائتمان رقم 1111  عند PAYMOBMEAT PART يوم 10-25 الساعة 19:40 المتاح 2000 جم', -31],
    ['CIB', 'تم خصم مبلغ  EGP 900.00 من بطاقة الخصم المباشر المنتهية بـ **2222 عند CARREFOUR MAADI في 20/10/26 18:02 ، الرصيد المتاح 9000.00 EGP', -36],
    ['CIB', 'رمز التحقق 123456 لعملية بمبلغ 500 جم', -2],
    ['Vodafone', 'تم شحن رصيدك بمبلغ 50 جنيه', -3]
  ];
  function readSmsSince(since) {
    if (hasAndroid) {
      try { return JSON.parse(window.Android.readSms(since) || '[]'); } catch (e) { return []; }
    }
    return SAMPLE.map(function (s, i) { return { id: i + 1, address: s[0], body: s[1], date: Date.now() + s[2] * 864e5 - i * 3600e3 }; })
      .filter(function (m) { return m.date > since; });
  }

  function defaultSenderOn(address) { var b = P.senderBank(address); return b === 'CIB' || b === 'NBE'; }

  function scan(full) {
    var since = full ? 0 : (D.settings.lastSmsDate || 0);
    var msgs = readSmsSince(since);
    var have = {};
    D.tx.forEach(function (t) { if (t.smsId != null) have[t.smsId] = 1; });
    if (full) Object.keys(D.senders).forEach(function (a) { D.senders[a].count = 0; });
    var added = 0, maxDate = D.settings.lastSmsDate || 0;
    msgs.forEach(function (m) {
      maxDate = Math.max(maxDate, m.date);
      var r = P.parseSms(m.body, m.address, m.date);
      if (!r) return;
      var a = m.address || 'Unknown';
      if (!D.senders[a]) D.senders[a] = { on: defaultSenderOn(a), count: 0 };
      D.senders[a].count++;
      var key = 's' + m.id;
      if (have[key]) return;
      var t = {
        id: key, smsId: key, sender: a, raw: m.body, date: m.date, dir: r.dir, amount: r.amount, currency: r.currency,
        merchant: r.merchant, bank: r.bank, card: r.card, cardType: r.cardType, kind: r.kind, cat: null
      };
      t.cat = D.rules[ruleKey(t.dir, t.merchant)] || null;
      D.tx.push(t); have[key] = 1;
      if (D.senders[a].on !== false) added++;
    });
    D.settings.lastSmsDate = maxDate;
    save();
    return added;
  }

  function doScan(full, quiet) {
    if (hasAndroid && !window.Android.hasSmsPermission()) { if (!quiet) toast('SMS access is off'); return; }
    var n = scan(full);
    if (!quiet || n) toast(n ? n + ' new transaction' + (n > 1 ? 's' : '') + ' found' : 'No new bank transactions');
    render();
  }

  function firstScan() {
    var n = scan(true);
    D.settings.onboarded = true;
    save();
    var u = unsortedCount();
    toast(n + ' transactions found');
    if (u) { UI.tab = 'tx'; UI.txMode = 'sort'; }
    render();
  }

  // ---------- Callbacks from Android ----------
  window.onSmsPermission = function (granted, canAskAgain) {
    if (granted) { if (!D.settings.onboarded) firstScan(); else doScan(false); return; }
    openSheet('<h3>SMS access was not given</h3>' +
      '<p class="small">The app needs SMS access to read your bank messages. Nothing leaves your phone.</p>' +
      '<p class="small">If Android says <b>"Restricted setting"</b> or the permission is greyed out:</p>' +
      '<ol class="small"><li>Tap <b>Open app settings</b> below.</li><li>Tap the <b>⋮</b> menu at the top right, then <b>Allow restricted settings</b>, and confirm.</li>' +
      '<li>Tap <b>Permissions › SMS › Allow</b>.</li><li>Come back to this app.</li></ol>' +
      '<div class="btns"><button class="btn" data-act="open-settings">Open app settings</button>' +
      (canAskAgain ? '<button class="btn ghost" data-act="ask-sms">Ask again</button>' : '') + '</div>', { type: 'perm' });
  };
  window.onAppResume = function () {
    if (!D || !D.settings.onboarded) { if (UI.tab === 'home') render(); return; }
    if (hasAndroid && window.Android.hasSmsPermission()) doScan(false, true);
    if (sheetCtx && sheetCtx.type === 'perm' && hasAndroid && window.Android.hasSmsPermission()) closeSheet();
  };
  window.onBack = function () {
    if (!sheetWrap.hidden) { saveNoteFromSheet(); closeSheet(); render(); return true; }
    if (UI.tab !== 'home') { UI.tab = 'home'; render(); return true; }
    return false;
  };
  window.onExportDone = function (ok) { toast(ok ? 'Backup saved' : 'Backup not saved'); };
  window.onImportDone = function (text) {
    if (text == null) return;
    try {
      var d = JSON.parse(text);
      if (d.app !== 'my-spending' || !d.data || !d.data.tx) throw new Error('bad');
      D = migrate(d.data);
      D.settings.onboarded = true;
      saveNow();
      toast('Restored ' + D.tx.length + ' transactions');
      closeSheet(); render();
    } catch (e) { toast('That file is not a My Spending backup'); }
  };

  function backup() {
    var json = JSON.stringify({ app: 'my-spending', v: 1, savedAt: new Date().toISOString(), data: D });
    var d = new Date();
    var name = 'my-spending-backup-' + d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + '.json';
    if (hasAndroid) window.Android.exportBackup(json, name);
    else {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = name; a.click();
    }
  }
  function restore() {
    if (hasAndroid) { window.Android.importBackup(); return; }
    var i = document.createElement('input'); i.type = 'file';
    i.onchange = function () { var r = new FileReader(); r.onload = function () { window.onImportDone(r.result); }; r.readAsText(i.files[0]); };
    i.click();
  }

  // ---------- Events ----------
  document.addEventListener('click', function (e) {
    var tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { UI.tab = tabBtn.dataset.tab; render(); window.scrollTo(0, 0); return; }
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act;
    if (el.tagName === 'A') e.preventDefault();
    switch (act) {
      case 'month-prev': UI.month = shiftKey(UI.month, -1); UI.trendSel = UI.daySel = null; render(); break;
      case 'month-next': UI.month = shiftKey(UI.month, 1); UI.trendSel = UI.daySel = null; render(); break;
      case 'close-sheet': saveNoteFromSheet(); closeSheet(); render(); break;
      case 'ask-sms':
        closeSheet();
        if (hasAndroid) window.Android.requestSmsPermission(); else window.onSmsPermission(true, true);
        break;
      case 'open-settings': if (hasAndroid) window.Android.openAppSettings(); break;
      case 'first-scan': firstScan(); break;
      case 'go-sort': UI.tab = 'tx'; UI.txMode = 'sort'; render(); window.scrollTo(0, 0); break;
      case 'txmode': UI.txMode = el.dataset.m; render(); break;
      case 'trend-sel': UI.trendSel = +el.dataset.i; render(); break;
      case 'day-sel': UI.daySel = UI.daySel === +el.dataset.i ? null : +el.dataset.i; render(); break;
      case 'cat-tx': {
        var c = catById(el.dataset.id);
        UI.tab = 'tx'; UI.txMode = c ? 'all' : 'sort'; UI.search = c ? c.name : ''; render(); window.scrollTo(0, 0); break;
      }
      case 'sort-group': openSortGroup(el.dataset.key); break;
      case 'group-one-by-one': {
        var key = el.dataset.key;
        var first = visibleTx().filter(function (t) { return !t.cat && (t.dir + '|' + P.merchantKey(t.merchant)) === key; })
          .sort(function (a, b) { return b.date - a.date; })[0];
        if (first) { var rem = document.getElementById('remember'); openTx(first.id); if (rem) document.getElementById('remember').checked = false; }
        break;
      }
      case 'open-tx': openTx(el.dataset.id); break;
      case 'pick-cat': {
        var remember = (document.getElementById('remember') || {}).checked;
        var ctx = sheetCtx;
        if (ctx.type === 'group') { applyCategoryToGroup(ctx.key, el.dataset.id, remember); closeSheet(); render(); }
        else if (ctx.type === 'tx') {
          saveNoteFromSheet();
          var t = txById(ctx.id);
          t.cat = el.dataset.id;
          var extra = 0;
          if (remember) {
            D.rules[ruleKey(t.dir, t.merchant)] = t.cat;
            var mk = P.merchantKey(t.merchant);
            D.tx.forEach(function (x) { if (!x.cat && x.dir === t.dir && P.merchantKey(x.merchant) === mk) { x.cat = t.cat; extra++; } });
          }
          save(); closeSheet(); render();
          toast('Sorted into ' + catById(t.cat).name + (extra ? ', plus ' + extra + ' more from ' + t.merchant : ''));
        }
        break;
      }
      case 'new-cat-inline': openCatForm(null, sheetCtx && sheetCtx.dir ? sheetCtx.dir : (sheetCtx && sheetCtx.id ? (txById(sheetCtx.id) || {}).dir : 'out') || 'out'); break;
      case 'uncat-tx': { var t2 = txById(sheetCtx.id); t2.cat = null; save(); closeSheet(); render(); break; }
      case 'edit-tx': saveNoteFromSheet(); openTxForm(txById(sheetCtx.id)); break;
      case 'del-tx': {
        var t3 = txById(sheetCtx.id);
        if (t3.manual) D.tx = D.tx.filter(function (x) { return x.id !== t3.id; });
        else t3.hidden = true;   // kept hidden so a re-read does not bring it back
        save(); closeSheet(); render(); toast(t3.manual ? 'Deleted' : 'Hidden'); break;
      }
      case 'add-tx': openTxForm(null); break;
      case 'form-dir': sheetCtx.dir = el.dataset.d;
        [].forEach.call(el.parentNode.children, function (b) { b.classList.toggle('on', b === el); }); break;
      case 'save-form': saveForm(); break;
      case 'edit-cat': openCatForm(catById(el.dataset.id)); break;
      case 'new-cat': openCatForm(null); break;
      case 'save-cat': saveCat(); break;
      case 'del-cat': {
        var id = sheetCtx.id;
        if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = 'Tap again to delete (its transactions become unsorted)'; break; }
        D.categories = D.categories.filter(function (c) { return c.id !== id; });
        D.tx.forEach(function (t) { if (t.cat === id) t.cat = null; });
        Object.keys(D.rules).forEach(function (k) { if (D.rules[k] === id) delete D.rules[k]; });
        save(); closeSheet(); render(); break;
      }
      case 'del-rule': delete D.rules[el.dataset.k]; save(); render(); break;
      case 'save-rates': {
        var bad = false;
        [].forEach.call(document.querySelectorAll('[data-rate]'), function (inp) {
          var v = P.parseNumber(inp.value);
          if (v > 0) D.settings.rates[inp.dataset.rate] = v; else if (inp.value.trim()) bad = true;
        });
        save(); toast(bad ? 'Some rates were not numbers and were skipped' : 'Rates saved'); render(); break;
      }
      case 'scan-new': doScan(false); break;
      case 'rescan-all': doScan(true); break;
      case 'card-up': case 'card-down': {
        var i = +el.dataset.i, j = act === 'card-up' ? i - 1 : i + 1, cs = D.settings.cards;
        var tmp = cs[i]; cs[i] = cs[j]; cs[j] = tmp; save(); render(); break;
      }
      case 'backup': backup(); break;
      case 'restore': restore(); break;
      case 'wipe':
        if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = 'Tap again to erase everything'; break; }
        D = defaultData(); saveNow(); UI.tab = 'home'; render(); toast('All data erased'); break;
    }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.dataset.sender) { D.senders[el.dataset.sender].on = el.checked; save(); toast(el.checked ? 'Included' : 'Hidden'); render(); }
    else if (el.dataset.card) {
      var h = D.settings.hiddenCards, c = el.dataset.card;
      if (el.checked) D.settings.hiddenCards = h.filter(function (x) { return x !== c; }); else if (h.indexOf(c) < 0) h.push(c);
      save();
    } else if (el.dataset.set) {
      var v = P.parseNumber(el.value);
      if (el.dataset.set === 'startDay') {
        v = Math.round(v);
        if (!(v >= 1 && v <= 28)) { toast('Use a day from 1 to 28'); el.value = D.settings.startDay; return; }
        D.settings.startDay = v; UI.month = periodKey(Date.now());
      } else {
        if (!(v >= 0)) { toast('Please type a number'); el.value = D.settings[el.dataset.set]; return; }
        D.settings[el.dataset.set] = v;
      }
      save(); toast('Saved');
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.dataset.input === 'search') {
      UI.search = e.target.value;
      var list = visibleTx().filter(function (t) { return periodKey(t.date) === UI.month && txMatches(t); }).sort(function (a, b) { return b.date - a.date; });
      var html = '', lastDay = '';
      list.forEach(function (t) {
        var dl = dayLabel(t.date);
        if (dl !== lastDay) { html += (lastDay ? '</div>' : '') + '<div class="day-h">' + dl + '</div><div class="card" style="padding:2px 12px">'; lastDay = dl; }
        html += txRow(t);
      });
      if (lastDay) html += '</div>';
      document.getElementById('txlist').innerHTML = html || '<div class="empty">Nothing matches.</div>';
    }
  });

  // ---------- Start ----------
  load();
  UI.month = periodKey(Date.now());
  if (D.settings.onboarded && (!hasAndroid || window.Android.hasSmsPermission())) scan(false);
  render();
})();

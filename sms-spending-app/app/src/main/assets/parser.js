/*
 * Bank SMS parser (CIB, NBE and similar Egyptian bank messages, Arabic or English).
 * parseSms(body, sender, dateMillis) -> transaction object, or null if the SMS
 * is not a completed money movement (OTP, declined, promo, etc).
 *
 * Works in the app and in Node (for tests).
 */
(function (root) {
  'use strict';

  // Arabic-Indic (٠١٢٣) and Persian (۰۱۲۳) digits -> 0123
  function normDigits(s) {
    return String(s || '')
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); })
      .replace(/٫/g, '.')   // Arabic decimal separator
      .replace(/٬/g, ',')   // Arabic thousands separator
      .replace(/[‎‏‪-‮⁦-⁩]/g, ''); // direction marks
  }

  // Parse a typed number: accepts Arabic digits, commas, spaces. Returns NaN if empty.
  function parseNumber(s) {
    var t = normDigits(s).replace(/[,\s]/g, '').replace(/[^\d.\-]/g, '');
    if (!t) return NaN;
    return parseFloat(t);
  }

  var IGNORE = /\bOTP\b|one[\s-]?time|verification|password|passcode|\bPIN\b|رمز|كود|كلمة\s*(?:ال)?مرور|declined|rejected|failed|unsuccessful|insufficient|not\s+completed|could\s+not|رفض|مرفوض|لم\s*تتم|لم\s*يتم|غير\s*ناجح|فشل|عدم\s*كفاية|غير\s*كاف/i;

  // Money going out / coming in. The earliest keyword in the message wins.
  var OUT_WORDS = /تم\s*خصم|خصم\s*مبلغ|تم\s*سحب|سحب\s*(?:نقدي|مبلغ)|تم\s*شراء|عملية\s*شراء|تم\s*سداد|تم\s*دفع|تم\s*تحويل\s*مبلغ.{0,40}?(?:إلى|الى|لحساب)|تحويل\s*صادر|debited|has\s+been\s+debited|\bdebit\s+(?:of|transaction)|purchase|withdraw(?:al|n)?|\bspent\b|\bpaid\b|payment\s+of|transferred\s+to|transfer\s+to|charged/i;
  var IN_WORDS = /تم\s*(?:إضافة|اضافة|ايداع|إيداع)|(?:إضافة|اضافة|ايداع|إيداع)\s*مبلغ|تحويل\s*وارد|تم\s*استلام|استرداد|credited|has\s+been\s+credited|deposit(?:ed)?|received|refund(?:ed)?|incoming\s+transfer|transfer\s+from/i;

  var CUR = '(EGP|USD|EUR|GBP|SAR|AED|KWD|L\\.?E\\.?|جم|ج\\.م\\.?|جنيه(?:اً|ا)?|جنية|دولار(?:اً|ا)?|يورو|ريال|درهم|\\$)';
  var NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
  var CUR_THEN_NUM = new RegExp(CUR + '\\s*' + NUM, 'i');
  var NUM_THEN_CUR = new RegExp(NUM + '\\s*' + CUR, 'i');
  var BALANCE = /المتاح|الرصيد|رصيد|available|avail\.?\s*bal|balance|\bbal\b|الحد\s*المتاح/i;

  function currencyCode(c) {
    c = (c || '').toUpperCase().replace(/\s/g, '');
    if (/^USD$|^\$$|دولار/.test(c)) return 'USD';
    if (/^EUR$|يورو/.test(c)) return 'EUR';
    if (/^GBP$/.test(c)) return 'GBP';
    if (/^SAR$|ريال/.test(c)) return 'SAR';
    if (/^AED$|درهم/.test(c)) return 'AED';
    if (/^KWD$/.test(c)) return 'KWD';
    return 'EGP';
  }

  function findAmount(text) {
    var a = CUR_THEN_NUM.exec(text), b = NUM_THEN_CUR.exec(text);
    var best = null;
    if (a) best = { idx: a.index, cur: a[1], num: a[2] };
    if (b && (!best || b.index < best.idx)) best = { idx: b.index, cur: b[2], num: b[1] };
    if (!best) {
      // "مبلغ 500" / "amount 500" with no currency -> EGP
      var m = /(?:مبلغ|amount(?:\s+of)?)\s*:?\s*(\d[\d,]*(?:\.\d+)?)/i.exec(text);
      if (m) best = { idx: m.index, cur: 'EGP', num: m[1] };
    }
    if (!best) return null;
    var v = parseFloat(best.num.replace(/,/g, ''));
    if (!(v > 0)) return null;
    return { amount: v, currency: currencyCode(best.cur) };
  }

  function cleanMerchant(m) {
    m = (m || '').replace(/[*_]+/g, ' ').replace(/\s+/g, ' ').trim();
    m = m.replace(/^[\-:،,.\s]+|[\-:،,.\s]+$/g, '');
    if (m.length > 40) m = m.slice(0, 40).trim();
    return m;
  }

  // Merchant name: after "عند" / "لدى" / "at", up to the date/time or punctuation.
  var MERCHANT = /(?:(?<=^|\s)(?:عند|لدى|لدي)(?=\s)|\bat\b)\s+(.+?)(?=\s+(?:في|يوم|بتاريخ|الساعة|on|dated|date)(?=\s|$)|\s+\d{1,2}[\/\-.]\d{1,2}|\s*[،,;]|\.\s|\s+-\s|$)/i;
  var TO_FROM = /(?:(?<=^|\s)(?:إلى|الى|لصالح)(?=\s)|\bto\b|\bfrom\b|(?<=^|\s)من(?=\s))\s+(?!(?:بطاقة|بطاقتك|حساب|حسابك|رصيد|your|account|card)(?:\s|$))([A-Za-z؀-ۿ][^،,.\d]{1,35}?)(?=\s+(?:في|يوم|بتاريخ|عبر|via|on|of|with|ref)(?=\s|$)|\s+\d|\s*[،,.]|$)/i;

  function senderBank(sender) {
    var s = String(sender || '');
    if (/CIB/i.test(s)) return 'CIB';
    if (/NBE|AHLY|الأهلي|الاهلي/i.test(s)) return 'NBE';
    if (/BANQUE\s*MISR|\bBM\b|مصر/i.test(s)) return 'Banque Misr';
    if (/QNB/i.test(s)) return 'QNB';
    return s || 'Unknown';
  }

  function parseSms(body, sender, dateMillis) {
    var raw = String(body || '');
    var t = normDigits(raw).replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (IGNORE.test(t)) return null;

    // "بطاقة الخصم المباشر" means "debit card" - it is not the word "debited".
    var forDir = t.replace(/الخصم\s*المباشر|debit\s*card/gi, ' CARD ');
    var o = OUT_WORDS.exec(forDir), i = IN_WORDS.exec(forDir);
    var dir = null;
    if (o && (!i || o.index <= i.index)) dir = 'out';
    else if (i) dir = 'in';
    if (!dir) return null;

    // Amount: look before the balance part first, so we don't pick up the balance.
    var bal = BALANCE.exec(t);
    var head = bal ? t.slice(0, bal.index) : t;
    var amt = findAmount(head) || (bal ? null : findAmount(t));
    if (!amt) return null;

    var merchant = '';
    var mm = MERCHANT.exec(head) || MERCHANT.exec(t);
    if (mm) merchant = cleanMerchant(mm[1]);
    if (!merchant) {
      var tf = TO_FROM.exec(head);
      if (tf) merchant = cleanMerchant(tf[1]);
    }

    var cardM = /(?:\*{2,}|x{2,}|رقم\s*:?\s*|ending\s*(?:in|with)?\s*|المنته?ي(?:ة|ه)?\s*ب\S*\s*\**)(\d{4})\b/i.exec(t);
    var card = cardM ? cardM[1] : '';

    var cardType = 'account';
    if (/ائتمان|ائتمانية|credit\s*card/i.test(t)) cardType = 'credit';
    else if (/الخصم\s*المباشر|debit\s*card|ميزة|meeza/i.test(t)) cardType = 'debit';
    else if (/مسبق(?:ة)?\s*الدفع|prepaid/i.test(t)) cardType = 'prepaid';

    var kind = 'card';
    if (/سحب|ATM|withdraw/i.test(t)) kind = 'cash';
    else if (/تحويل|transfer|انستاباي|instapay|IPN/i.test(t)) kind = 'transfer';
    else if (/استرداد|refund/i.test(t)) kind = 'refund';
    else if (dir === 'in') kind = 'incoming';

    if (!merchant) {
      merchant = kind === 'cash' ? 'Cash withdrawal'
        : kind === 'transfer' ? (dir === 'in' ? 'Transfer in' : 'Transfer out')
        : kind === 'refund' ? 'Refund'
        : dir === 'in' ? 'Money in' : 'Payment';
    }

    return {
      dir: dir,
      amount: amt.amount,
      currency: amt.currency,
      merchant: merchant,
      card: card,
      cardType: cardType,
      kind: kind,
      bank: senderBank(sender),
      date: dateMillis || Date.now()
    };
  }

  // Key used to remember "this merchant = this category".
  function merchantKey(m) {
    return normDigits(m || '').toUpperCase().replace(/[^A-Z؀-ۿ0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  var api = {
    parseSms: parseSms, normDigits: normDigits, parseNumber: parseNumber,
    merchantKey: merchantKey, senderBank: senderBank
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SmsParser = api;
})(this);

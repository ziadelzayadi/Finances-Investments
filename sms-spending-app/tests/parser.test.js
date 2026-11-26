// Run: node sms-spending-app/tests/parser.test.js
// Example messages use made-up numbers in the real CIB/NBE formats.
const P = require('../app/src/main/assets/parser.js');
const assert = require('assert');
let n = 0;
function t(name, body, sender, expect) {
  const r = P.parseSms(body, sender, 1700000000000);
  try {
    if (expect === null) assert.strictEqual(r, null);
    else for (const k in expect) assert.deepStrictEqual(r && r[k], expect[k], k);
    n++;
  } catch (e) { console.error('FAIL', name, '\n  got', r, '\n ', e.message); process.exitCode = 1; }
}
t('NBE credit card Arabic', 'تم خصم 120 جم من بطاقة الائتمان رقم 1234  عند PAYMOBMEAT PART يوم 11-25 الساعة 19:40 المتاح 5000.50 جم للمزيد اتصل ب 19623.', 'NBE',
  { dir: 'out', amount: 120, currency: 'EGP', merchant: 'PAYMOBMEAT PART', card: '1234', cardType: 'credit', bank: 'NBE' });
t('CIB debit card Arabic', 'تم خصم مبلغ  EGP 245.03 من بطاقة الخصم المباشر المنتهية بـ **9876 عند ZOOBA في 20/11/26 12:21 ، الرصيد المتاح 1000.78 EGP', 'CIB',
  { dir: 'out', amount: 245.03, currency: 'EGP', merchant: 'ZOOBA', card: '9876', cardType: 'debit', bank: 'CIB' });
t('Arabic-Indic digits', 'تم خصم ١٬٢٥٠٫٥٠ جم من بطاقة الائتمان رقم ١٢٣٤ عند CARREFOUR يوم ١١-٢٥ المتاح ٣٠٠ جم', 'NBE',
  { dir: 'out', amount: 1250.5, merchant: 'CARREFOUR', card: '1234' });
t('Incoming USD', 'تم إضافة مبلغ USD 300.00 إلى حسابك رقم 5555 في 21/11/26 الرصيد المتاح USD 900.00', 'CIB',
  { dir: 'in', amount: 300, currency: 'USD' });
t('English debit', 'Your CIB debit card ending with 4321 was used for EGP 1,500.00 purchase at AMAZON EG on 22/11/26. Available balance EGP 9,000.00', 'CIB',
  { dir: 'out', amount: 1500, currency: 'EGP', merchant: 'AMAZON EG', card: '4321' });
t('English credited', 'Your account 1234 has been credited with USD 250.00 on 23/11/26. Balance USD 800.00', 'CIB',
  { dir: 'in', amount: 250, currency: 'USD' });
t('Refund to debit card', 'تم إضافة مبلغ 99 جم إلى بطاقة الخصم المباشر المنتهية بـ **9876 من TALABAT الرصيد المتاح 100 جم', 'CIB',
  { dir: 'in', amount: 99 });
t('ATM', 'تم سحب مبلغ 2000 جم من بطاقة الخصم المباشر رقم 9876 من ATM CIB في 20/11 الرصيد 50 جم', 'CIB',
  { dir: 'out', amount: 2000, kind: 'cash' });
t('OTP ignored', 'رمز التحقق الخاص بك هو 123456 لعملية بمبلغ 500 جم', 'CIB', null);
t('Declined ignored', 'تم رفض عملية بمبلغ 500 جم على بطاقتك رقم 1234', 'NBE', null);
t('Promo ignored', 'خصم 20% على مشترياتك في رمضان', 'CIB', null);
assert.strictEqual(P.parseNumber('١٢٬٥٠٠٫٧٥'), 12500.75); n++;
assert.strictEqual(P.parseNumber('12,500'), 12500); n++;
assert.ok(isNaN(P.parseNumber(''))); n++;
console.log(n + ' checks run' + (process.exitCode ? ' (with failures)' : ', all passed'));

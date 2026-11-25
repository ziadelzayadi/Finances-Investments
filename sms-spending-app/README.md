# My Spending (Android)

A private Android app that reads CIB and NBE bank SMS on the phone, turns them
into transactions, lets you sort them into your own categories, and shows a
spending dashboard with healthy / unhealthy indicators. EGP first; USD shown in
both USD and EGP using a rate you type in.

**Privacy:** the app has no `INTERNET` permission (see `AndroidManifest.xml`),
so it cannot send anything anywhere. Its only permission is `READ_SMS`.

## How it is built (no computer needed)
GitHub builds it: `.github/workflows/build-sms-app.yml` runs on every change in
this folder and puts `MySpending.apk` on the repo's Releases page under
**sms-app-latest**. Download that file on the phone and install it.

## Where things are
- `app/src/main/java/.../MainActivity.kt` – asks for SMS permission, reads the inbox, saves data, backup/restore.
- `app/src/main/assets/parser.js` – understands the bank SMS text (Arabic + English, Arabic digits).
- `app/src/main/assets/app.js` – the screens: dashboard, transactions, categories, settings.
- `app/src/main/assets/style.css` – the look.
- `tests/parser.test.js` – checks the parser against sample messages (made-up numbers).
- `app/signing.keystore` – fixed signing key so each new build installs as an update and keeps your data.
  Only install this app from your own Releases page.

To add a new SMS format: add a sample to `tests/parser.test.js`, adjust `parser.js`.

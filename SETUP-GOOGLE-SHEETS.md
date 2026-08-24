# Google Sheets setup

**You do not need this for CSV or Excel.** Those work immediately, with no
Google account. This is only for the optional "append leads to a Google Sheet"
feature.

Roughly five minutes. You do it once.

---

## Why you have to do this yourself

A Google OAuth client ID for a Chrome extension is **bound to that extension's
ID**. Your unpacked extension gets its own unique ID on your machine, so no
client ID shipped in this ZIP could ever work for you. That is why
`manifest.json` contains a clearly-labelled placeholder and the UI reports
"not configured" instead of pretending to be connected.

---

## Step 1 — Get a stable extension ID

An unpacked extension's ID normally changes if you move the folder. Pin it:

1. Open a terminal in the folder **containing** `al-aqsa-scraper` and run:

   ```bash
   openssl genrsa -out key.pem 2048
   openssl rsa -in key.pem -pubout -outform DER 2>/dev/null | openssl base64 -A
   ```

2. Copy the long base64 string it prints.
3. Open `manifest.json` and add it as a top-level `"key"` entry:

   ```json
   {
     "manifest_version": 3,
     "key": "PASTE_THE_BASE64_STRING_HERE",
     "name": "Al-Aqsa Scraper",
     ...
   }
   ```

4. Keep `key.pem` somewhere safe and **outside** the extension folder.

> **Skipping this is fine** if you never move the folder. Just load the
> extension and read its ID off `chrome://extensions`. If the ID later changes,
> you repeat Step 3 with the new one.

---

## Step 2 — Note your extension ID

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → select the folder
2. Copy the **ID** shown on the extension's card (32 lowercase letters)

The side panel also shows it: **Export → Google Sheets** displays your extension
ID in the setup card.

---

## Step 3 — Create the OAuth client

1. Go to **https://console.cloud.google.com**
2. Create a project (or pick one) — name it anything, e.g. `Al-Aqsa Scraper`
3. **APIs & Services → Library** → search **Google Sheets API** → **Enable**
4. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name: `Al-Aqsa Scraper`, plus your email in the two contact fields
   - **Scopes**: add `https://www.googleapis.com/auth/spreadsheets`
   - **Test users**: add your own Google address
   - Save. You can leave it in "Testing" — you do not need Google verification
     for your own account.
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Chrome Extension**
   - Application ID: paste the extension ID from Step 2
   - Create, then copy the client ID
     (it ends in `.apps.googleusercontent.com`)

---

## Step 4 — Put it in the manifest

Open `manifest.json` and replace the placeholder:

```json
"oauth2": {
  "client_id": "123456789012-abcdefghijklmnop.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file"
  ]
}
```

Then `chrome://extensions` → **Reload** on the extension card.

---

## Step 5 — Use it

Side panel → **Export** → Google Sheets:

1. **Sign in with Google** — Chrome shows the consent screen
2. **Create New Sheet** (a spreadsheet with headers is made and opened for you)
   — or paste an existing spreadsheet URL and press **Use This Sheet**
3. **Append leads to Google Sheets**

Leave **"Skip leads already in the sheet"** ticked and you can append the same
job repeatedly without creating duplicates. Existing rows are matched on Maps
URL first, then business name + phone, then business name + full address.

---

## Scopes, and why they are what they are

| Scope | Why |
|---|---|
| `spreadsheets` | Read the header row and existing leads; append new rows |
| `drive.file` | Create a new spreadsheet. This scope only grants access to files **this extension created** — it cannot see the rest of your Drive |

There is **no client secret**. A Chrome extension is a public OAuth client;
Google does not issue one and embedding one would be a security defect.

**No access token is ever written to storage.** `chrome.identity` holds it in
Chrome's own credential store. Signing out removes the cached token and revokes
it with Google.

---

## Troubleshooting

**"No OAuth client ID configured in manifest.json"**
Step 4 wasn't done, or the extension wasn't reloaded after editing.

**"Authorization page could not be loaded" / `bad client id`**
The Application ID on the OAuth client doesn't match your current extension ID.
Compare `chrome://extensions` against the Google Cloud credential and fix
whichever is stale. This is what Step 1 prevents.

**"Access blocked: has not completed the Google verification process"**
Add your Google address under **OAuth consent screen → Test users**.

**"Request had insufficient authentication scopes"**
The scopes in `manifest.json` and on the consent screen disagree. Make both
include `https://www.googleapis.com/auth/spreadsheets`, reload the extension,
sign out, sign back in.

**Sign-in fails and I need my leads now**
Use **Export CSV** or **Export Excel**. They never touch Google, and a Sheets
failure cannot affect them — or your scraping.

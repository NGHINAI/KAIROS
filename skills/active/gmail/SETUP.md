# Gmail OAuth Setup for KAIROS

KAIROS uses OAuth 2.0 (not a service account) to access Gmail. Service accounts
require Google Workspace with domain-wide delegation — for a personal Gmail account,
OAuth with a long-lived refresh token is the right approach.

## What you need

1. A Google Cloud project (free, takes ~2 minutes to create)
2. Gmail API enabled on that project
3. An OAuth 2.0 Desktop App client ID + secret
4. One-time browser authorization to generate a refresh token

---

## Step 1 — Create a Google Cloud project

1. Go to https://console.cloud.google.com/
2. Click the project dropdown at the top → **New Project**
3. Name it `kairos` (or anything), click **Create**
4. Wait ~30 seconds for it to provision

---

## Step 2 — Enable the Gmail API

1. In your project, go to **APIs & Services → Library**
2. Search for **Gmail API**
3. Click it → **Enable**

---

## Step 3 — Configure the OAuth consent screen

Before creating credentials, Google needs a consent screen:

1. Go to **APIs & Services → OAuth consent screen**
2. Select **External** → **Create**
3. Fill in:
   - App name: `KAIROS`
   - User support email: your Gmail address
   - Developer contact email: your Gmail address
4. Click **Save and Continue** through the Scopes and Test Users screens
   (you don't need to add scopes here — the app requests them at runtime)
5. On the **Test users** page, add your Gmail address as a test user
6. Click **Save and Continue** → **Back to Dashboard**

> The app stays in "Testing" mode. That's fine — KAIROS only accesses your own inbox.
> Testing mode allows up to 100 users and tokens last 7 days. To get non-expiring
> refresh tokens, publish the app (Step 3b below).

### Step 3b — Publish to get a non-expiring refresh token (recommended)

While in testing mode, refresh tokens expire after 7 days, requiring re-auth.
To avoid this:

1. On the OAuth consent screen page, click **Publish App**
2. Confirm the warning (since it's your own app, no Google review is needed
   unless you request sensitive scopes — the Gmail scopes used here require review
   if you publish publicly, but for personal use it's fine to stay in testing
   and just re-authorize every 7 days)

**Alternative**: Use the `prompt: 'consent'` flag (already set in `auth.js`) — this
forces a new refresh token on every authorization. Re-run `setup-oauth.js` when
the token expires.

---

## Step 4 — Create OAuth 2.0 credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Desktop app**
4. Name: `KAIROS Desktop`
5. Click **Create**
6. In the popup, copy the **Client ID** and **Client Secret**

---

## Step 5 — Add credentials to secrets.json

Edit `state/secrets.json` and replace the placeholder values:

```json
"google_oauth": {
  "client_id": "123456789-abc123.apps.googleusercontent.com",
  "client_secret": "GOCSPX-your-actual-secret",
  "redirect_uri": "urn:ietf:wg:oauth:2.0:oob"
}
```

> The `redirect_uri` value `urn:ietf:wg:oauth:2.0:oob` is the "Out-of-Band" flow —
> it shows the auth code on-screen for you to copy, rather than redirecting to a
> localhost server. It's deprecated by Google but still functional for Desktop apps.

---

## Step 6 — Authorize KAIROS

Run the interactive setup wizard:

```bash
node skills/active/gmail/setup-oauth.js
```

It will:
1. Print an authorization URL
2. Open it in your browser (or you can copy-paste it)
3. After you grant access, Google shows a code
4. Paste the code back into the terminal
5. The token is saved to `state/gmail_token.json`

---

## Step 7 — Verify

```bash
node skills/active/gmail/gmail.js status
```

Expected output:
```json
{
  "ok": true,
  "status": "connected",
  "email": "you@gmail.com",
  "messages_total": 12345,
  "threads_total": 5678,
  "token_expiry": "2026-06-01T..."
}
```

---

## Usage

```bash
# Check inbox (last 5 emails)
node skills/active/gmail/gmail.js read

# Check unread
node skills/active/gmail/gmail.js unread

# Search
node skills/active/gmail/gmail.js search "from:notifications@github.com" --count=10

# Send
node skills/active/gmail/gmail.js send "you@example.com" "Subject" "Body text"

# List labels
node skills/active/gmail/gmail.js labels
```

---

## Token lifecycle

- Stored at: `state/gmail_token.json` (gitignored)
- `auth.js` auto-refreshes the access token if it expires within 5 minutes
- Refresh tokens don't expire unless:
  - You revoke access in your Google Account settings
  - The app is in Testing mode (tokens expire after 7 days)
  - You haven't used it in 6 months (Google's inactivity policy)
- Re-run `setup-oauth.js` to get a fresh token at any time

---

## Revoking access

To revoke KAIROS's access to your Gmail:
1. Go to https://myaccount.google.com/permissions
2. Find **KAIROS** → **Remove Access**
3. Delete `state/gmail_token.json` locally

---

## Why not a service account?

Service accounts are for server-to-server auth. To use one with Gmail, you need
Google Workspace (paid) with domain-wide delegation enabled — it doesn't work with
free `@gmail.com` accounts. OAuth 2.0 with a Desktop app client is the standard
pattern for personal Gmail access.

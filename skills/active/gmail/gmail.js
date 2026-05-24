#!/usr/bin/env node
// KAIROS Gmail skill — read, send, search, label management.
// Usage:
//   ./gmail.js read [--count=N] [--label=INBOX]
//   ./gmail.js send <to> <subject> <body>
//   ./gmail.js search <query> [--count=N]
//   ./gmail.js labels
//   ./gmail.js unread
//   ./gmail.js status

import { google } from 'googleapis'
import { getAuthenticatedClient, loadToken, loadCredentials } from './auth.js'

const [, , operation = 'status', ...rest] = process.argv

function parseFlags(args) {
  const flags = {}
  const positional = []
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/)
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : true
    else positional.push(arg)
  }
  return { flags, positional }
}

function output(data) {
  console.log(JSON.stringify(data, null, 2))
}

function fail(message, setup_required = false) {
  output({ ok: false, error: message, setup_required })
  process.exit(1)
}

function decodeBase64Url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function extractBody(payload) {
  if (!payload) return ''
  // Prefer text/plain part
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data).slice(0, 500)
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part)
      if (text) return text
    }
  }
  return ''
}

function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

async function getGmail() {
  // Check credentials exist
  try {
    loadCredentials()
  } catch (err) {
    fail(
      'Gmail not configured. Add google_oauth credentials to state/secrets.json, ' +
      'then run: node skills/active/gmail/setup-oauth.js',
      true
    )
  }

  // Check token exists
  const token = loadToken()
  if (!token) {
    fail(
      'Gmail not authorized. Run: node skills/active/gmail/setup-oauth.js',
      true
    )
  }

  const auth = await getAuthenticatedClient()
  return google.gmail({ version: 'v1', auth })
}

async function cmdStatus() {
  try {
    loadCredentials()
  } catch (err) {
    return output({
      ok: false,
      status: 'not_configured',
      message: err.message,
      setup_required: true,
      next_step: 'node skills/active/gmail/setup-oauth.js',
      docs: 'skills/active/gmail/SETUP.md',
    })
  }

  const token = loadToken()
  if (!token) {
    return output({
      ok: false,
      status: 'not_authorized',
      message: 'Credentials found but no token. Run setup-oauth.js to authorize.',
      setup_required: true,
      next_step: 'node skills/active/gmail/setup-oauth.js',
    })
  }

  // Try a lightweight API call to verify the token works
  try {
    const auth = await getAuthenticatedClient()
    const gmail = google.gmail({ version: 'v1', auth })
    const profile = await gmail.users.getProfile({ userId: 'me' })
    output({
      ok: true,
      status: 'connected',
      email: profile.data.emailAddress,
      messages_total: profile.data.messagesTotal,
      threads_total: profile.data.threadsTotal,
      token_expiry: token.expiry_date ? new Date(token.expiry_date).toISOString() : 'unknown',
    })
  } catch (err) {
    output({
      ok: false,
      status: 'auth_error',
      error: err.message,
      setup_required: true,
    })
  }
}

async function cmdRead({ count = 5, label = 'INBOX' }) {
  const gmail = await getGmail()
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    labelIds: [label],
    maxResults: Number(count),
  })

  const messages = listRes.data.messages ?? []
  if (messages.length === 0) {
    return output({ ok: true, label, count: 0, emails: [] })
  }

  const emails = await Promise.all(
    messages.map(async ({ id }) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      })
      const h = msg.data.payload?.headers ?? []
      return {
        id,
        subject: getHeader(h, 'Subject'),
        from: getHeader(h, 'From'),
        to: getHeader(h, 'To'),
        date: getHeader(h, 'Date'),
        snippet: msg.data.snippet?.slice(0, 200) ?? '',
        body_preview: extractBody(msg.data.payload),
        labels: msg.data.labelIds ?? [],
        unread: (msg.data.labelIds ?? []).includes('UNREAD'),
      }
    })
  )

  output({ ok: true, label, count: emails.length, emails })
}

async function cmdUnread() {
  const gmail = await getGmail()
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['UNREAD', 'INBOX'],
    maxResults: 10,
  })

  const messages = listRes.data.messages ?? []
  if (messages.length === 0) {
    return output({ ok: true, unread_count: 0, emails: [] })
  }

  const emails = await Promise.all(
    messages.map(async ({ id }) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      })
      const h = msg.data.payload?.headers ?? []
      return {
        id,
        subject: getHeader(h, 'Subject'),
        from: getHeader(h, 'From'),
        date: getHeader(h, 'Date'),
        snippet: msg.data.snippet?.slice(0, 150) ?? '',
      }
    })
  )

  output({ ok: true, unread_count: emails.length, emails })
}

async function cmdSearch(query, { count = 10 }) {
  if (!query) return fail('search requires a query string')
  const gmail = await getGmail()
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: Number(count),
  })

  const messages = listRes.data.messages ?? []
  const emails = await Promise.all(
    messages.map(async ({ id }) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      })
      const h = msg.data.payload?.headers ?? []
      return {
        id,
        subject: getHeader(h, 'Subject'),
        from: getHeader(h, 'From'),
        date: getHeader(h, 'Date'),
        snippet: msg.data.snippet?.slice(0, 200) ?? '',
      }
    })
  )

  output({ ok: true, query, count: emails.length, emails })
}

async function cmdSend(to, subject, body) {
  if (!to || !subject || !body) {
    return fail('send requires: <to> <subject> <body>')
  }
  const gmail = await getGmail()

  const profile = await gmail.users.getProfile({ userId: 'me' })
  const from = profile.data.emailAddress

  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body,
  ].join('\r\n')

  const encoded = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  })

  output({
    ok: true,
    message_id: res.data.id,
    thread_id: res.data.threadId,
    from,
    to,
    subject,
  })
}

async function cmdLabels() {
  const gmail = await getGmail()
  const res = await gmail.users.labels.list({ userId: 'me' })
  const labels = (res.data.labels ?? []).map(l => ({
    id: l.id,
    name: l.name,
    type: l.type,
    messages_total: l.messagesTotal,
    messages_unread: l.messagesUnread,
  }))
  output({ ok: true, count: labels.length, labels })
}

// Dispatch
try {
  const { flags, positional } = parseFlags(rest)

  switch (operation) {
    case 'status':
      await cmdStatus()
      break
    case 'read':
      await cmdRead({ count: flags.count ?? 5, label: flags.label ?? 'INBOX' })
      break
    case 'unread':
      await cmdUnread()
      break
    case 'search':
      await cmdSearch(positional[0], { count: flags.count ?? 10 })
      break
    case 'send':
      await cmdSend(positional[0], positional[1], positional[2] ?? flags.body)
      break
    case 'labels':
      await cmdLabels()
      break
    default:
      fail(`Unknown operation: ${operation}. Use: status, read, unread, search, send, labels`)
  }
} catch (err) {
  fail(err.message)
}

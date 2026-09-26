import express from "express";
import Database from "better-sqlite3";
import sanitizeHtml from "sanitize-html";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT) || 3000;

// CHANGE THESE (or set via env vars)
const DB_PATH = process.env.DB_PATH || "./emails.db";
const TABLE_NAME = process.env.TABLE_NAME || "messages";

// ------------------------------------------------------------
// Open the database
// ------------------------------------------------------------
//
// The connection is read-only, so it will not create the file
// if it is missing. Fail with a clear message instead of the
// raw SQLite error.

const resolvedDbPath = path.resolve(DB_PATH);

if (!fs.existsSync(resolvedDbPath)) {
    console.error(`Database not found: ${resolvedDbPath}`);
    console.error("Set DB_PATH to your database, or run `npm run seed` to create a sample one.");
    process.exit(1);
}

const db = new Database(resolvedDbPath, {
    readonly: true
});

// NOTE: `PRAGMA journal_mode = WAL` is a write operation and
// throws on a read-only connection. A WAL database can be read
// read-only without setting it, so we do not touch it here.

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function parseValue(value) {
    if (!value) return null;

    try {
        return typeof value === "string"
            ? JSON.parse(value)
            : value;
    } catch {
        return null;
    }
}

function parseEmailAddress(value) {
    if (!value) return [];

    if (Array.isArray(value)) {
        return value.flatMap(parseEmailAddress);
    }

    const text = String(value);

    // Handles:
    // John Doe <john@example.com>
    // john@example.com
    // John Doe <john@example.com>, Jane <jane@example.com>
    const matches = [
        ...text.matchAll(
            /(?:[^<,]*<)?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*>?/gi
        )
    ];

    if (matches.length) {
        return matches.map(m => m[1].toLowerCase());
    }

    if (text.includes("@")) {
        return text
            .split(",")
            .map(x => x.trim().toLowerCase())
            .filter(Boolean);
    }

    return [];
}

function emailAddressList(value) {
    return parseEmailAddress(value);
}

function isPreplyEmail(email) {
    const from = email.from || "";

    const fromAddresses = parseEmailAddress(from);

    return fromAddresses.some(address =>
        address.endsWith("@preply.com") ||
        address.endsWith(".preply.com")
    );
}

function normalizeDate(date) {
    if (!date) return 0;

    const timestamp = Date.parse(date);

    return Number.isNaN(timestamp)
        ? 0
        : timestamp;
}

// ------------------------------------------------------------
// Load all Preply emails
// ------------------------------------------------------------

function loadPreplyEmails() {
    const rows = db
        .prepare(`
            SELECT rowid AS _rowid, value
            FROM ${TABLE_NAME}
            WHERE value IS NOT NULL
        `)
        .all();

    const emails = [];

    for (const row of rows) {
        const email = parseValue(row.value);

        if (!email) continue;

        if (!isPreplyEmail(email)) continue;

        const recipients = emailAddressList(email.to);

        if (!recipients.length) continue;

        emails.push({
            ...email,
            _rowid: row._rowid,
            _recipients: recipients
        });
    }

    emails.sort(
        (a, b) =>
            normalizeDate(a.date) -
            normalizeDate(b.date)
    );

    return emails;
}

// ------------------------------------------------------------
// Compile recipient index
// ------------------------------------------------------------

function buildRecipientIndex(emails) {
    const recipients = new Map();

    for (const email of emails) {
        for (const recipient of email._recipients) {
            if (!recipients.has(recipient)) {
                recipients.set(recipient, []);
            }

            recipients
                .get(recipient)
                .push(email);
        }
    }

    return [...recipients.entries()]
        .map(([email, messages]) => ({
            email,
            count: messages.length,
            latest: messages[messages.length - 1]?.date || null
        }))
        .sort((a, b) => {
            return (
                normalizeDate(b.latest) -
                normalizeDate(a.latest)
            );
        });
}

// ------------------------------------------------------------
// HTML email sanitization
// ------------------------------------------------------------

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function renderEmailBody(email) {
    const body = email.body || "";

    if (!body) {
        return "<div class=\"empty-body\">No HTML body</div>";
    }

    if (email.bodyType === "html") {
        return sanitizeHtml(body, {
            allowedTags: [
                "html",
                "head",
                "body",
                "style",

                "div",
                "span",
                "p",
                "br",

                "a",

                "img",

                "table",
                "thead",
                "tbody",
                "tfoot",
                "tr",
                "td",
                "th",

                "strong",
                "b",
                "em",
                "i",
                "u",
                "s",

                "ul",
                "ol",
                "li",

                "blockquote",

                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",

                "pre",
                "code",

                "hr"
            ],

            allowedAttributes: {
                "*": [
                    "class",
                    "id",
                    "style",
                    "dir",
                    "align",
                    "valign",
                    "width",
                    "height"
                ],

                "a": [
                    "href",
                    "target",
                    "rel"
                ],

                "img": [
                    "src",
                    "alt",
                    "width",
                    "height",
                    "style"
                ]
            },

            allowedSchemes: [
                "http",
                "https",
                "mailto",
                "data"
            ],

            allowProtocolRelative: false
        });
    }

    return `<pre>${escapeHtml(body)}</pre>`;
}

function formatDate(date) {
    if (!date) return "";

    const parsed = new Date(date);

    if (Number.isNaN(parsed.getTime())) {
        return String(date);
    }

    return parsed.toLocaleString();
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------

app.get("/api/recipients", (req, res) => {
    const emails = loadPreplyEmails();

    const recipients = buildRecipientIndex(emails);

    res.json({
        count: recipients.length,
        recipients
    });
});

app.get("/api/recipient", (req, res) => {
    const requested = String(req.query.email || "")
        .trim()
        .toLowerCase();

    if (!requested) {
        return res.status(400).json({
            error: "Missing email"
        });
    }

    const emails = loadPreplyEmails();

    const matching = emails
        .filter(email =>
            email._recipients.includes(requested)
        )
        .map(email => ({
            id: email.id,
            threadId: email.threadId,
            messageId: email.messageId,
            from: email.from,
            to: email.to,
            subject: email.subject,
            date: email.date,
            snippet: email.snippet,
            // Sanitize on the way out. The frontend injects this
            // straight into the DOM, so it must already be safe.
            body: renderEmailBody(email),
            bodyType: email.bodyType,
            attachments: email.attachments || []
        }));

    res.json({
        recipient: requested,
        count: matching.length,
        emails: matching
    });
});

// ------------------------------------------------------------
// Frontend
// ------------------------------------------------------------

app.get("/", (req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>Preply Mail</title>

<style>

* {
    box-sizing: border-box;
}

html,
body {
    margin: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    font-family: Arial, Helvetica, sans-serif;
}

body {
    background: #f7f8fa;
    color: #202124;
}

.app {
    display: flex;
    width: 100%;
    height: 100vh;
}

/* ----------------------------------------------------------
   COLUMN 1 — RECIPIENTS
---------------------------------------------------------- */

.sidebar {
    width: 300px;
    min-width: 300px;
    background: #fff;
    border-right: 1px solid #e0e0e0;
    display: flex;
    flex-direction: column;
}

.sidebar-header {
    height: 60px;
    display: flex;
    align-items: center;
    padding: 0 20px;
    border-bottom: 1px solid #eee;
    font-size: 20px;
    font-weight: 600;
    color: #d33b2c;
}

.search {
    padding: 12px;
    border-bottom: 1px solid #eee;
}

.search input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #ddd;
    border-radius: 8px;
    outline: none;
    font-size: 14px;
}

.recipient-list {
    flex: 1;
    overflow-y: auto;
}

.recipient {
    padding: 12px 18px;
    border-bottom: 1px solid #f0f0f0;
    cursor: pointer;
}

.recipient:hover {
    background: #f5f7fa;
}

.recipient.active {
    background: #fce8e6;
    box-shadow: inset 3px 0 0 #d33b2c;
}

.recipient-email {
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.recipient-meta {
    margin-top: 4px;
    color: #777;
    font-size: 12px;
    display: flex;
    justify-content: space-between;
}

/* ----------------------------------------------------------
   COLUMN 2 — MESSAGE LIST
---------------------------------------------------------- */

.maillist {
    width: 400px;
    min-width: 320px;
    background: #fff;
    border-right: 1px solid #e0e0e0;
    display: flex;
    flex-direction: column;
}

.maillist-header {
    height: 60px;
    display: flex;
    align-items: center;
    padding: 0 20px;
    border-bottom: 1px solid #e0e0e0;
    flex-shrink: 0;
}

.maillist-title {
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.maillist-title .count {
    color: #777;
    font-weight: 400;
}

.message-list {
    flex: 1;
    overflow-y: auto;
}

.message {
    padding: 12px 18px;
    border-bottom: 1px solid #f0f0f0;
    cursor: pointer;
}

.message:hover {
    background: #f5f7fa;
}

.message.active {
    background: #e8f0fe;
    box-shadow: inset 3px 0 0 #1967d2;
}

.message-top {
    display: flex;
    justify-content: space-between;
    gap: 10px;
}

.message-subject {
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.message-date {
    font-size: 12px;
    color: #777;
    white-space: nowrap;
    flex-shrink: 0;
}

.message-snippet {
    margin-top: 4px;
    color: #666;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* ----------------------------------------------------------
   COLUMN 3 — READING PANE
---------------------------------------------------------- */

.reader {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: #fff;
}

.reader-body {
    flex: 1;
    overflow-y: auto;
}

.read-header {
    padding: 22px 32px 16px;
    border-bottom: 1px solid #eee;
}

.read-subject {
    font-size: 22px;
    font-weight: 500;
    margin-bottom: 12px;
}

.read-line {
    font-size: 13px;
    color: #555;
    margin-top: 3px;
}

.read-line b {
    color: #202124;
}

.read-date {
    margin-top: 6px;
    font-size: 12px;
    color: #888;
}

.read-content {
    padding: 22px 32px 40px;
    overflow-x: auto;
}

.read-content img {
    max-width: 100%;
    height: auto;
}

.read-content table {
    max-width: 100%;
}

.read-content a {
    color: #1967d2;
}

.empty {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #999;
    font-size: 15px;
    text-align: center;
    padding: 20px;
}

.loading {
    padding: 30px;
    color: #777;
}

.error {
    padding: 30px;
    color: #b00020;
}

/* ----------------------------------------------------------
   MOBILE
---------------------------------------------------------- */

@media (max-width: 900px) {
    .sidebar {
        width: 200px;
        min-width: 200px;
    }
    .maillist {
        width: 280px;
        min-width: 240px;
    }
    .read-header,
    .read-content {
        padding-left: 18px;
        padding-right: 18px;
    }
}

</style>
</head>

<body>

<div class="app">

    <!-- Column 1: recipients -->
    <aside class="sidebar">
        <div class="sidebar-header">Preply Mail</div>

        <div class="search">
            <input id="search" type="search" placeholder="Search recipients...">
        </div>

        <div id="recipientList" class="recipient-list"></div>
    </aside>

    <!-- Column 2: message list -->
    <section class="maillist">
        <div class="maillist-header">
            <div id="mailListTitle" class="maillist-title">Select a recipient</div>
        </div>
        <div id="messageList" class="message-list">
            <div class="empty">No recipient selected</div>
        </div>
    </section>

    <!-- Column 3: reading pane -->
    <main class="reader">
        <div id="readerBody" class="reader-body">
            <div class="empty">Select an email to read it here</div>
        </div>
    </main>

</div>

<script>

let recipients = [];
let selectedRecipient = null;
let currentEmails = [];
let selectedEmailIdx = null;

const recipientList = document.getElementById("recipientList");
const mailListTitle = document.getElementById("mailListTitle");
const messageList = document.getElementById("messageList");
const readerBody = document.getElementById("readerBody");
const search = document.getElementById("search");

// ----------------------------------------------------------
// Recipients (column 1)
// ----------------------------------------------------------

async function loadRecipients() {
    recipientList.innerHTML = '<div class="loading">Loading...</div>';

    try {
        const response = await fetch("/api/recipients");

        if (!response.ok) {
            throw new Error("Failed to load recipients");
        }

        const data = await response.json();
        recipients = data.recipients;
        renderRecipients();
    } catch (error) {
        recipientList.innerHTML =
            '<div class="error">' + escapeHtml(error.message) + '</div>';
    }
}

function renderRecipients() {
    const query = search.value.trim().toLowerCase();

    const filtered = recipients.filter(item =>
        item.email.toLowerCase().includes(query)
    );

    recipientList.innerHTML = "";

    if (!filtered.length) {
        recipientList.innerHTML = '<div class="empty">No recipients</div>';
        return;
    }

    for (const recipient of filtered) {
        const element = document.createElement("div");

        element.className =
            "recipient" +
            (selectedRecipient === recipient.email ? " active" : "");

        element.innerHTML = \`
            <div class="recipient-email">\${escapeHtml(recipient.email)}</div>
            <div class="recipient-meta">
                <span>\${recipient.count} email\${recipient.count === 1 ? "" : "s"}</span>
                <span>\${formatDate(recipient.latest)}</span>
            </div>
        \`;

        element.onclick = () => openRecipient(recipient.email);
        recipientList.appendChild(element);
    }
}

// ----------------------------------------------------------
// Message list (column 2)
// ----------------------------------------------------------

async function openRecipient(email) {
    selectedRecipient = email;
    selectedEmailIdx = null;
    currentEmails = [];

    renderRecipients();

    mailListTitle.innerHTML = escapeHtml(email);
    messageList.innerHTML = '<div class="loading">Loading emails...</div>';
    readerBody.innerHTML = '<div class="empty">Select an email to read it here</div>';

    try {
        const response = await fetch(
            "/api/recipient?email=" + encodeURIComponent(email)
        );

        if (!response.ok) {
            throw new Error("Failed to load emails");
        }

        const data = await response.json();

        // Newest first, like Gmail.
        currentEmails = data.emails.slice().reverse();

        renderMessageList();

        // Auto-open the most recent email.
        if (currentEmails.length) {
            openEmail(0);
        }
    } catch (error) {
        messageList.innerHTML =
            '<div class="error">' + escapeHtml(error.message) + '</div>';
    }
}

function renderMessageList() {
    const n = currentEmails.length;

    mailListTitle.innerHTML =
        escapeHtml(selectedRecipient) +
        ' <span class="count">(' + n + ')</span>';

    if (!n) {
        messageList.innerHTML = '<div class="empty">No emails found</div>';
        return;
    }

    messageList.innerHTML = "";

    currentEmails.forEach((email, idx) => {
        const element = document.createElement("div");

        element.className = "message" + (selectedEmailIdx === idx ? " active" : "");

        const subject = email.subject || "(no subject)";
        const snippet = email.snippet || "";

        element.innerHTML = \`
            <div class="message-top">
                <div class="message-subject">\${escapeHtml(subject)}</div>
                <div class="message-date">\${formatShortDate(email.date)}</div>
            </div>
            <div class="message-snippet">\${escapeHtml(snippet)}</div>
        \`;

        element.onclick = () => openEmail(idx);
        messageList.appendChild(element);
    });
}

// ----------------------------------------------------------
// Reading pane (column 3)
// ----------------------------------------------------------

function openEmail(idx) {
    selectedEmailIdx = idx;
    renderMessageList();

    const email = currentEmails[idx];
    if (!email) return;

    const subject = email.subject || "(no subject)";
    const from = email.from || "";
    const to = email.to || "";

    /*
     * email.body was already sanitized server-side by
     * sanitize-html (see renderEmailBody), so it is safe
     * to inject here.
     */
    const body = email.body || '<div class="empty">No body</div>';

    readerBody.innerHTML = \`
        <div class="read-header">
            <div class="read-subject">\${escapeHtml(subject)}</div>
            <div class="read-line"><b>From:</b> \${escapeHtml(from)}</div>
            <div class="read-line"><b>To:</b> \${escapeHtml(to)}</div>
            <div class="read-date">\${escapeHtml(formatDate(email.date))}</div>
        </div>
        <div class="read-content">\${body}</div>
    \`;

    readerBody.scrollTop = 0;
}

// ----------------------------------------------------------
// Search
// ----------------------------------------------------------

search.addEventListener("input", renderRecipients);

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
}

function formatShortDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    const now = new Date();
    const sameYear = date.getFullYear() === now.getFullYear();

    return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: sameYear ? undefined : "numeric"
    });
}

loadRecipients();

</script>

</body>
</html>`);
});

// ------------------------------------------------------------
// Start
// ------------------------------------------------------------

app.listen(PORT, () => {

    console.log(
        `Email viewer running at http://localhost:${PORT}`
    );

    console.log(
        `Database: ${resolvedDbPath}`
    );

});

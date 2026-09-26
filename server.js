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
    font-family:
        Arial,
        Helvetica,
        sans-serif;
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
   LEFT RECIPIENT LIST
---------------------------------------------------------- */

.sidebar {
    width: 320px;
    min-width: 320px;

    background: #fff;

    border-right: 1px solid #ddd;

    display: flex;
    flex-direction: column;
}

.sidebar-header {
    height: 64px;

    display: flex;
    align-items: center;

    padding: 0 20px;

    border-bottom: 1px solid #eee;

    font-size: 20px;
    font-weight: 600;
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
    padding: 14px 18px;

    border-bottom: 1px solid #f0f0f0;

    cursor: pointer;
}

.recipient:hover {
    background: #f5f7fa;
}

.recipient.active {
    background: #e8f0fe;
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
   VIEWER
---------------------------------------------------------- */

.viewer {
    flex: 1;

    min-width: 0;

    display: flex;
    flex-direction: column;

    background: #fff;
}

.viewer-header {
    height: 64px;

    border-bottom: 1px solid #ddd;

    display: flex;
    align-items: center;

    padding: 0 24px;

    flex-shrink: 0;
}

.viewer-title {
    font-size: 18px;
    font-weight: 600;
}

.viewer-content {
    flex: 1;

    overflow-y: auto;

    padding: 0;
}

/* ----------------------------------------------------------
   EMAILS
---------------------------------------------------------- */

.email {
    border-bottom: 1px solid #ddd;
}

.email-header {
    padding: 18px 28px;

    background: #fff;
}

.email-from {
    font-size: 14px;
    font-weight: 600;
}

.email-to {
    margin-top: 4px;

    color: #666;

    font-size: 13px;
}

.email-subject {
    margin-top: 12px;

    font-size: 18px;
    font-weight: 500;
}

.email-date {
    margin-top: 5px;

    color: #777;

    font-size: 12px;
}

.email-body {
    padding: 20px 28px 35px;

    overflow-x: auto;
}

.email-body img {
    max-width: 100%;
}

.email-body table {
    max-width: 100%;
}

.email-body a {
    color: #1967d2;
}

.empty {
    height: 100%;

    display: flex;
    align-items: center;
    justify-content: center;

    color: #888;

    font-size: 15px;
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

@media (max-width: 800px) {

    .sidebar {
        width: 260px;
        min-width: 260px;
    }

    .email-header,
    .email-body {
        padding-left: 18px;
        padding-right: 18px;
    }
}

</style>
</head>

<body>

<div class="app">

    <aside class="sidebar">

        <div class="sidebar-header">
            Preply Mail
        </div>

        <div class="search">
            <input
                id="search"
                type="search"
                placeholder="Search recipients..."
            >
        </div>

        <div
            id="recipientList"
            class="recipient-list"
        ></div>

    </aside>

    <main class="viewer">

        <div
            id="viewerHeader"
            class="viewer-header"
        >
            <div class="viewer-title">
                Select a recipient
            </div>
        </div>

        <div
            id="viewerContent"
            class="viewer-content"
        >
            <div class="empty">
                Select a recipient to view their emails
            </div>
        </div>

    </main>

</div>

<script>

let recipients = [];
let selectedRecipient = null;

const recipientList =
    document.getElementById("recipientList");

const viewerHeader =
    document.getElementById("viewerHeader");

const viewerContent =
    document.getElementById("viewerContent");

const search =
    document.getElementById("search");

// ----------------------------------------------------------
// Load recipients
// ----------------------------------------------------------

async function loadRecipients() {

    recipientList.innerHTML =
        '<div class="loading">Loading...</div>';

    try {

        const response =
            await fetch("/api/recipients");

        if (!response.ok) {
            throw new Error(
                "Failed to load recipients"
            );
        }

        const data =
            await response.json();

        recipients =
            data.recipients;

        renderRecipients();

    } catch (error) {

        recipientList.innerHTML =
            '<div class="error">' +
            escapeHtml(error.message) +
            '</div>';
    }
}

// ----------------------------------------------------------
// Render recipient list
// ----------------------------------------------------------

function renderRecipients() {

    const query =
        search.value
            .trim()
            .toLowerCase();

    const filtered =
        recipients.filter(item =>
            item.email
                .toLowerCase()
                .includes(query)
        );

    recipientList.innerHTML = "";

    for (const recipient of filtered) {

        const element =
            document.createElement("div");

        element.className =
            "recipient" +
            (
                selectedRecipient === recipient.email
                    ? " active"
                    : ""
            );

        element.innerHTML = \`
            <div class="recipient-email">
                \${escapeHtml(recipient.email)}
            </div>

            <div class="recipient-meta">
                <span>
                    \${recipient.count}
                    email\${recipient.count === 1 ? "" : "s"}
                </span>

                <span>
                    \${formatDate(recipient.latest)}
                </span>
            </div>
        \`;

        element.onclick = () =>
            openRecipient(recipient.email);

        recipientList.appendChild(element);
    }
}

// ----------------------------------------------------------
// Open recipient
// ----------------------------------------------------------

async function openRecipient(email) {

    selectedRecipient = email;

    renderRecipients();

    viewerHeader.innerHTML = \`
        <div class="viewer-title">
            \${escapeHtml(email)}
        </div>
    \`;

    viewerContent.innerHTML =
        '<div class="loading">Loading emails...</div>';

    try {

        const response =
            await fetch(
                "/api/recipient?email=" +
                encodeURIComponent(email)
            );

        if (!response.ok) {
            throw new Error(
                "Failed to load emails"
            );
        }

        const data =
            await response.json();

        renderEmails(data.emails);

    } catch (error) {

        viewerContent.innerHTML =
            '<div class="error">' +
            escapeHtml(error.message) +
            '</div>';
    }
}

// ----------------------------------------------------------
// Render all emails for recipient
// ----------------------------------------------------------

function renderEmails(emails) {

    if (!emails.length) {

        viewerContent.innerHTML =
            '<div class="empty">' +
            'No emails found' +
            '</div>';

        return;
    }

    viewerContent.innerHTML =
        emails
            .map(renderEmail)
            .join("");
}

// ----------------------------------------------------------
// Render individual email
// ----------------------------------------------------------

function renderEmail(email) {

    const subject =
        email.subject ||
        "(no subject)";

    const from =
        email.from ||
        "";

    const to =
        email.to ||
        "";

    const date =
        formatDate(email.date);

    const body =
        email.body || "";

    /*
     * The email HTML is inserted into the viewer.
     *
     * Scripts and unsafe markup were already removed
     * server-side by sanitize-html (see renderEmailBody).
     */

    return \`
        <article class="email">

            <header class="email-header">

                <div class="email-from">
                    From: \${escapeHtml(from)}
                </div>

                <div class="email-to">
                    To: \${escapeHtml(to)}
                </div>

                <div class="email-subject">
                    \${escapeHtml(subject)}
                </div>

                <div class="email-date">
                    \${escapeHtml(date)}
                </div>

            </header>

            <div class="email-body">
                \${body}
            </div>

        </article>
    \`;
}

// ----------------------------------------------------------
// Search
// ----------------------------------------------------------

search.addEventListener(
    "input",
    renderRecipients
);

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

    const date =
        new Date(value);

    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toLocaleString();
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

import Database from "better-sqlite3";
import path from "node:path";

// Creates a small sample database so the viewer can be run and
// tested without a real email export. Matches the schema the
// server expects: a table with a JSON `value` column, one email
// per row.

const DB_PATH = process.env.DB_PATH || "./emails.db";
const TABLE_NAME = process.env.TABLE_NAME || "messages";

const resolved = path.resolve(DB_PATH);

const db = new Database(resolved);

db.exec(`
    DROP TABLE IF EXISTS ${TABLE_NAME};
    CREATE TABLE ${TABLE_NAME} (
        value TEXT
    );
`);

const sampleEmails = [
    {
        id: "1",
        threadId: "t1",
        messageId: "m1",
        from: "Preply <notifications@preply.com>",
        to: "Student One <student.one@example.com>",
        subject: "Your lesson is confirmed",
        date: "2026-09-20T10:15:00Z",
        snippet: "Your lesson with Maria is confirmed for tomorrow.",
        bodyType: "html",
        body: "<p>Hi there,</p><p>Your lesson with <strong>Maria</strong> is confirmed. <a href=\"https://preply.com\">View details</a>.</p><script>alert('xss')</script>"
    },
    {
        id: "2",
        threadId: "t2",
        messageId: "m2",
        from: "tutor-team.preply.com <team@tutor-team.preply.com>",
        to: "student.one@example.com, Student Two <student.two@example.com>",
        subject: "Reschedule request",
        date: "2026-09-22T08:00:00Z",
        snippet: "A reschedule has been requested.",
        bodyType: "text",
        body: "Plain text body with <angle> brackets that must be escaped."
    },
    {
        id: "3",
        threadId: "t3",
        messageId: "m3",
        from: "Someone Else <hello@notpreply.com>",
        to: "student.one@example.com",
        subject: "Should be filtered out (not preply)",
        date: "2026-09-23T09:00:00Z",
        snippet: "Not a preply email.",
        bodyType: "text",
        body: "This email should not appear."
    },
    {
        id: "4",
        threadId: "t4",
        messageId: "m4",
        from: "Preply <notifications@preply.com>",
        to: "Student Two <student.two@example.com>",
        subject: "Weekly summary",
        date: "2026-09-25T18:30:00Z",
        snippet: "Here is your weekly learning summary.",
        bodyType: "html",
        body: "<h2>Weekly summary</h2><ul><li>2 lessons completed</li><li>1 upcoming</li></ul>"
    }
];

const insert = db.prepare(`INSERT INTO ${TABLE_NAME} (value) VALUES (?)`);

const insertAll = db.transaction(rows => {
    for (const row of rows) {
        insert.run(JSON.stringify(row));
    }
});

insertAll(sampleEmails);

console.log(`Seeded ${sampleEmails.length} rows into ${resolved} (table: ${TABLE_NAME})`);

db.close();

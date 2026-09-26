# Preply Mail Viewer

A small read-only web viewer for Preply emails stored in a SQLite database.
Emails are grouped by recipient; clicking a recipient shows every Preply
message sent to them, with HTML bodies sanitized server-side.

## Expected database

The server reads one table (default `messages`) with a JSON `value` column,
one email object per row, e.g.:

```json
{
  "from": "Preply <notifications@preply.com>",
  "to": "Student <student@example.com>",
  "subject": "Your lesson is confirmed",
  "date": "2026-09-20T10:15:00Z",
  "bodyType": "html",
  "body": "<p>...</p>"
}
```

Only emails whose `from` address ends in `@preply.com` or `.preply.com`
are shown.

## Run

```bash
npm install

# Point at your database (defaults shown):
export DB_PATH=./emails.db
export TABLE_NAME=messages

# Or create a small sample database to try it out:
npm run seed

npm start
```

Then open http://localhost:3000.

## Config (environment variables)

| Var          | Default        | Meaning                          |
| ------------ | -------------- | -------------------------------- |
| `PORT`       | `3000`         | HTTP port                        |
| `DB_PATH`    | `./emails.db`  | Path to the SQLite database file |
| `TABLE_NAME` | `messages`     | Table holding the JSON `value`   |

## Notes / fixes applied to the original scrap

- **HTML is now actually sanitized.** The API returns sanitized bodies
  (`sanitize-html`) instead of raw HTML, so the frontend's assumption that
  scripts were stripped server-side now holds.
- **Removed `PRAGMA journal_mode = WAL`**, which throws on a read-only
  connection.
- **Clear error when the database file is missing** instead of a raw
  SQLite failure.
- `PORT`, `DB_PATH`, and `TABLE_NAME` are configurable via env vars.

# Seller Academy: an LMS for HashiCorp sellers

A lightweight internal learning management system for the sales org:

- **Import people** from a CSV (from Workday or Salesforce exports). Re-imports update people in place, and the CSV carries the manager hierarchy.
- **Build learning plans**: ordered sequences of content (courses, videos, docs, quizzes, live sessions), each item required or optional, with a default due date.
- **Assign** a whole plan or a single item to specific people or to everyone matching a filter (team, region, segment, role).
- **Track progress**: learners mark items started or complete. Plans complete automatically when every required item is done. Progress is per item, so finishing an item counts toward every plan that contains it.
- **Reports**: completion by plan and by team, an overdue list, and a per-plan learner × item matrix you can export to CSV. Managers see only their own reporting tree.
- **Slack**:
  - a DM when someone is assigned learning
  - reminders when work is overdue or due soon
  - a digest of overdue reports for managers, sent each time reminders run
  - shout-outs in a channel when someone completes a plan
  - a `/learn` command with **Mark complete** buttons

## Quick start

```bash
npm install
npm run seed      # demo users, content, plans, assignments
npm start         # http://localhost:3000
```

Sign in (dev mode) as `admin@example.com` (admin), `sam.rivera@example.com` (manager) or `jordan.lee@example.com` (learner).

Requires Node 22.13+. It uses Node's built-in SQLite, so Express is the only dependency. Run `npm test` for the test suite.

## Roles

| Role | Can do |
| --- | --- |
| `learner` | See and complete their own assignments, browse plans and content |
| `manager` | Everything a learner can do, plus see people and reports for their whole reporting tree and assign learning within it |
| `admin` | Everything, including importing and editing people, plans and content, and Slack admin |

## Importing users

Upload a CSV from **People → Import CSV**, or `POST /api/users/import` with `Content-Type: text/csv`. Only `email` is required for updates. New people also need a `name`.

```
email,name,title,role,team,region,segment,manager_email,slack_user_id
jordan.lee@example.com,Jordan Lee,Account Executive,learner,Enterprise West,AMER,Enterprise,sam.rivera@example.com,
```

- Rows are matched by email, case-insensitively. Blank cells on an existing user leave that field unchanged.
- `manager_email` can point at anyone in the database or anywhere in the same file.
- Set `active` to `false` to deactivate someone. Deactivated users can't sign in and are skipped by filter-based assignment and reminders.
- Bad rows are reported with the row number and don't block the rest of the file.

## Slack setup

1. Create an app from [`slack-app-manifest.yml`](slack-app-manifest.yml), replacing `https://lms.example.com` with this server's public URL.
2. Install it to the workspace, then set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. Optionally set `SLACK_ANNOUNCE_CHANNEL` (for example `#sales-wins`) for plan-completion shout-outs.
3. Run `npm run reminders` once a day (cron, Kubernetes CronJob, Nomad periodic job…), or set `REMINDER_INTERVAL_HOURS`.

People are matched to Slack by email (`users.lookupByEmail`), and the Slack ID is cached on the user. **Slack → Link users by email** backfills everyone at once. Each learner gets at most one reminder every 3 days.

Without a Slack token, every Slack feature is skipped and the rest of the LMS works normally.

## Authentication

- `AUTH_MODE=dev` (the default) shows an email-only sign-in form. **Use it only locally.**
- `AUTH_MODE=header` is for production. Put the app behind an SSO proxy, such as [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) with Okta, that sets a verified email header (`TRUSTED_EMAIL_HEADER`, default `x-forwarded-email`). In this mode the app must not be reachable except through the proxy. `/slack/*` has to bypass SSO, because Slack calls it directly and authenticates each request with its signature.

`ADMIN_EMAILS` (comma-separated) bootstraps admins on startup. See [`.env.example`](.env.example) for all settings.

## API overview

All endpoints are under `/api` and use JSON.

| Method & path | Who | Purpose |
| --- | --- | --- |
| `GET /me`, `GET /me/learning` | all | Current user and their assignments with progress |
| `POST /progress` `{itemId, status}` | all | `status`: `not_started` \| `in_progress` \| `completed`. Admins may pass `userId`. |
| `GET /users`, `GET /users/facets` | staff | List or filter people |
| `POST /users`, `PATCH /users/:id`, `POST /users/import` | admin | Manage people |
| `GET /users/:id/learning` | staff | One person's assignments |
| `GET/POST/PATCH/DELETE /content[/:id]` | read: all, write: admin | Content library |
| `GET/POST/PATCH /plans[/:id]` | read: all, write: admin | Plans. `items: [{item_id, required}]` sets the order. |
| `POST /assignments` | staff | `{planId \| itemId, userIds?, filter?, allUsers?, dueAt?, notify?}` |
| `PATCH/DELETE /assignments/:id` | staff | Change the due date or unassign |
| `GET /reports/overview`, `GET /reports/plans/:id[?format=csv]` | staff | Reporting |
| `POST /slack/reminders`, `POST /slack/link-users` | admin | Run Slack jobs on demand |

## Layout

```
src/db.js            SQLite schema
src/lms.js           Domain logic: users/import, content, plans, assignments, progress, reports
src/slack.js         Slack outbound messages, reminders, /learn and button handling
src/auth.js          Dev login / SSO-header auth, signed session cookie
src/routes/          HTTP routes (API + Slack)
public/              Single-page front end (no build step)
scripts/             seed + daily reminders
test/                node:test suites (domain, API permissions, Slack with a fake Web API)
```

## Possible next steps

- Automatic HRIS sync (Workday) instead of CSV upload
- SCORM/xAPI packages or LMS-hosted quizzes with scoring
- Auto-assign rules, for example "new hires in AMER Enterprise get Onboarding"
- Postgres for multi-instance deployments

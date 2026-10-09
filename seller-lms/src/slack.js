'use strict';

const crypto = require('node:crypto');
const lms = require('./lms');

/**
 * Slack integration. Everything is a no-op unless SLACK_BOT_TOKEN is set, so the LMS
 * works fine without Slack. Required bot scopes: chat:write, users:read, users:read.email,
 * commands (for /learn).
 */
function createSlack({
  token = process.env.SLACK_BOT_TOKEN,
  signingSecret = process.env.SLACK_SIGNING_SECRET,
  announceChannel = process.env.SLACK_ANNOUNCE_CHANNEL,
  appUrl = process.env.APP_URL || 'http://localhost:3000',
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const enabled = Boolean(token);

  async function call(method, body) {
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error}`);
    return json;
  }

  // Find (and cache) a user's Slack id from their email.
  async function slackIdFor(db, user) {
    if (user.slack_user_id) return user.slack_user_id;
    try {
      const { user: su } = await call('users.lookupByEmail', { email: user.email });
      db.prepare('UPDATE users SET slack_user_id = ? WHERE id = ?').run(su.id, user.id);
      return su.id;
    } catch (err) {
      logger.warn(`[slack] no Slack user for ${user.email}: ${err.message}`);
      return null;
    }
  }

  async function dm(db, user, text, blocks) {
    if (!enabled) return false;
    const channel = await slackIdFor(db, user);
    if (!channel) return false;
    await call('chat.postMessage', { channel, text, blocks });
    return true;
  }

  // Run notifications without ever failing the request that triggered them.
  async function safely(label, fn) {
    if (!enabled) return { sent: 0, failed: 0 };
    try { return await fn(); } catch (err) {
      logger.error(`[slack] ${label}: ${err.message}`);
      return { sent: 0, failed: 1, error: err.message };
    }
  }

  function dueText(dueAt) {
    return dueAt ? `Due *${dueAt}*` : 'No due date';
  }

  function assignmentBlocks(title, a, extra = []) {
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `:mortar_board: You've been assigned *${title}*\n${dueText(a.due_at)}` } },
      ...extra,
      {
        type: 'actions',
        elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in LMS' }, url: `${appUrl}/#/my-learning`, action_id: 'open_lms' }],
      },
    ];
  }

  async function notifyAssigned(db, { created, plan, item }) {
    return safely('notifyAssigned', async () => {
      const title = plan ? plan.title : item.title;
      let sent = 0, failed = 0;
      for (const { assignment, user } of created) {
        const extra = plan
          ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `${plan.items.length} item(s)${plan.description ? ` · ${plan.description}` : ''}` }] }]
          : [];
        try {
          (await dm(db, user, `You've been assigned ${title}`, assignmentBlocks(title, assignment, extra))) ? sent++ : failed++;
        } catch (err) {
          failed++;
          logger.error(`[slack] DM to ${user.email} failed: ${err.message}`);
        }
      }
      return { sent, failed };
    });
  }

  async function announceCompletions(db, user, completedAssignments) {
    if (!announceChannel || !completedAssignments.length) return { sent: 0, failed: 0 };
    return safely('announceCompletions', async () => {
      let sent = 0;
      for (const a of completedAssignments) {
        if (!a.plan_id) continue; // only celebrate whole plans
        const plan = lms.getPlan(db, a.plan_id);
        const who = user.slack_user_id ? `<@${user.slack_user_id}>` : user.name;
        await call('chat.postMessage', { channel: announceChannel, text: `:tada: ${who} completed the *${plan.title}* learning plan!` });
        sent++;
      }
      return { sent, failed: 0 };
    });
  }

  /**
   * DM learners whose assignments are overdue or due within `soonDays`, at most once per
   * `everyDays`, and send each manager a digest of their overdue reports.
   */
  async function sendReminders(db, { soonDays = 3, everyDays = 3 } = {}) {
    if (!enabled) return { enabled: false, learners: 0, managers: 0 };
    const t = lms.today();
    const soon = lms.addDays(t, soonDays);
    const cutoff = lms.addDays(t, -everyDays + 1);
    const due = db.prepare(`
      SELECT a.*, COALESCE(p.title, c.title) AS title
      FROM assignments a JOIN users u ON u.id = a.user_id
      LEFT JOIN learning_plans p ON p.id = a.plan_id
      LEFT JOIN content_items c ON c.id = a.item_id
      WHERE a.completed_at IS NULL AND a.due_at IS NOT NULL AND a.due_at <= ? AND u.active = 1
        AND (a.last_reminded_at IS NULL OR date(a.last_reminded_at) < ?)
      ORDER BY a.user_id, a.due_at`).all(soon, cutoff);

    const byUser = Map.groupBy(due, (a) => a.user_id);
    let learners = 0;
    for (const [userId, list] of byUser) {
      const user = lms.getUser(db, userId);
      const lines = list.map((a) => {
        const pct = lms.assignmentProgress(db, a).percent;
        const flag = a.due_at < t ? ':red_circle: *overdue*' : ':large_yellow_circle: due soon';
        return `• *${a.title}* — ${flag} (${a.due_at}) · ${pct}% complete`;
      });
      try {
        const ok = await dm(db, user, 'You have learning due', [
          { type: 'section', text: { type: 'mrkdwn', text: `:wave: Hi ${user.name.split(' ')[0]}, a reminder about your learning:\n${lines.join('\n')}` } },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in LMS' }, url: `${appUrl}/#/my-learning`, action_id: 'open_lms' }] },
        ]);
        if (ok) {
          learners++;
          const mark = db.prepare("UPDATE assignments SET last_reminded_at = datetime('now') WHERE id = ?");
          for (const a of list) mark.run(a.id);
        }
      } catch (err) {
        logger.error(`[slack] reminder to ${user.email} failed: ${err.message}`);
      }
    }

    const overdueByManager = Map.groupBy(lms.listOverdue(db).filter((a) => a.manager_id), (a) => a.manager_id);
    let managers = 0;
    for (const [managerId, list] of overdueByManager) {
      const manager = lms.getUser(db, managerId);
      const lines = list.map((a) => `• ${a.user_name} — *${a.title}* (due ${a.due_at})`);
      try {
        if (await dm(db, manager, 'Team learning overdue', [
          { type: 'section', text: { type: 'mrkdwn', text: `:clipboard: *Overdue learning on your team*\n${lines.join('\n')}` } },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View report' }, url: `${appUrl}/#/reports`, action_id: 'open_reports' }] },
        ])) managers++;
      } catch (err) {
        logger.error(`[slack] digest to ${manager.email} failed: ${err.message}`);
      }
    }
    return { enabled: true, learners, managers };
  }

  // ------------------------------------------------------------ inbound (slash command + buttons)

  function verifySignature(rawBody, headers, now = Date.now()) {
    if (!signingSecret) return false;
    const ts = headers['x-slack-request-timestamp'];
    const sig = headers['x-slack-signature'];
    if (!ts || !sig || Math.abs(now / 1000 - Number(ts)) > 60 * 5) return false;
    const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex');
    return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  }

  // Blocks summarizing a learner's open assignments, with a "mark complete" button for each next step.
  function learningSummaryBlocks(db, user) {
    const open = lms.getUserLearning(db, user.id).filter((a) => !a.completed_at);
    if (!open.length) {
      return [{ type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark: You have no open learning assignments. Nice work!' } }];
    }
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: 'Your learning' } }];
    for (const a of open.slice(0, 10)) {
      const next = a.items.find((it) => it.status !== 'completed');
      const status = a.overdue ? ':red_circle: overdue' : dueText(a.due_at);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${a.title}* — ${a.progress.completed}/${a.progress.total} done · ${status}${next ? `\nNext: ${next.url ? `<${next.url}|${next.title}>` : next.title}` : ''}` },
        ...(next && {
          accessory: { type: 'button', text: { type: 'plain_text', text: 'Mark complete' }, action_id: 'complete_item', value: String(next.id), style: 'primary' },
        }),
      });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${appUrl}/#/my-learning|Open the LMS>` }] });
    return blocks;
  }

  function handleCommand(db, form) {
    const user = lms.getUserBySlackId(db, form.user_id);
    if (!user) {
      return { response_type: 'ephemeral', text: "I couldn't match your Slack account to an LMS user. Ask an LMS admin to add your Slack ID or email." };
    }
    const arg = (form.text || '').trim().toLowerCase();
    if (arg === 'help') {
      return { response_type: 'ephemeral', text: '`/learn` — show your open learning and mark items complete.' };
    }
    return { response_type: 'ephemeral', text: 'Your learning', blocks: learningSummaryBlocks(db, user) };
  }

  async function handleInteraction(db, payload) {
    const action = payload.actions?.[0];
    if (action?.action_id !== 'complete_item') return null;
    const user = lms.getUserBySlackId(db, payload.user?.id);
    if (!user) return null;
    const completed = lms.setProgress(db, user.id, Number(action.value), 'completed');
    await announceCompletions(db, user, completed);
    if (payload.response_url) {
      await fetchImpl(payload.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replace_original: true, text: 'Your learning', blocks: learningSummaryBlocks(db, user) }),
      });
    }
    return { completed };
  }

  // Ensure users who reach us via Slack have their Slack id recorded.
  async function linkUsersByEmail(db) {
    if (!enabled) return { linked: 0 };
    let linked = 0;
    for (const u of db.prepare('SELECT * FROM users WHERE slack_user_id IS NULL AND active = 1').all()) {
      if (await slackIdFor(db, u)) linked++;
    }
    return { linked };
  }

  return {
    enabled,
    status: () => ({ enabled, signingSecret: Boolean(signingSecret), announceChannel: announceChannel || null }),
    notifyAssigned, announceCompletions, sendReminders, linkUsersByEmail,
    verifySignature, handleCommand, handleInteraction,
  };
}

module.exports = { createSlack };

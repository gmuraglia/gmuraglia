/*
  Redmine Daily Report (Node.js)
  - Reads env: REDMINE_BASE_URL, REDMINE_API_KEY, PROJECT_IDS (comma sep, optional)
             REPORT_TZ_OFFSET (hours, default -3 for ART), DAYS_BACK (default 1)
             SLACK_WEBHOOK_URL (optional)
  - Email via SMTP (preferred) or Resend HTTP fallback
  - Collects:
    * Issues created yesterday
    * Issues updated yesterday
    * Issues closed yesterday (using closed_on)
    * Time entries logged yesterday (sum by project and by user)
  - Prints Markdown summary to STDOUT and posts to Slack / sends email if configured
*/

const nodemailer = (() => { try { return require('nodemailer'); } catch { return null; } })();

const BASE_URL = process.env.REDMINE_BASE_URL || "";
const API_KEY = process.env.REDMINE_API_KEY || "";
const PROJECT_IDS = (process.env.PROJECT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const REPORT_TZ_OFFSET = parseInt(process.env.REPORT_TZ_OFFSET || "-3", 10); // hours
const DAYS_BACK = parseInt(process.env.DAYS_BACK || "1", 10);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const DUE_SOON_DAYS = parseInt(process.env.DUE_SOON_DAYS || "7", 10);
// Email (Resend API)
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
// Email (SMTP)
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_SECURE = (process.env.SMTP_SECURE || "false").toLowerCase() === "true"; // true for 465
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

const EMAIL_TO = (process.env.EMAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_SUBJECT_PREFIX = process.env.EMAIL_SUBJECT_PREFIX || "Redmine Diario";

if (!BASE_URL || !API_KEY) {
  console.error("Missing REDMINE_BASE_URL or REDMINE_API_KEY env vars");
  process.exit(2);
}

function toYYYYMMDD(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getLocalDayRange(daysBack, offsetHours) {
  const now = new Date();
  const localNow = new Date(now.getTime() + offsetHours * 3600 * 1000);
  const startLocal = new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate() - daysBack, 0, 0, 0);
  const endLocal = new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate() - daysBack, 23, 59, 59);
  const startUTC = new Date(startLocal.getTime() - offsetHours * 3600 * 1000);
  const endUTC = new Date(endLocal.getTime() - offsetHours * 3600 * 1000);
  return { startUTC, endUTC };
}

async function redmineGet(path, params = {}) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { "X-Redmine-API-Key": API_KEY, Accept: "application/json" },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Redmine GET ${url} -> ${res.status} ${res.statusText} ${txt}`);
  }
  return res.json();
}

async function fetchIssuesUpdatedSince(startUTC, endUTC) {
  const results = [];
  const limit = 100;
  let offset = 0;
  // Fetch sorted desc by updated_on, stop when older than startUTC or max 1000 items
  const paramsCommon = { status_id: "*", sort: "updated_on:desc", limit };

  while (true) {
    const params = { ...paramsCommon, offset };
    // Project scoping: loop per project if defined to reduce data; else global
    if (PROJECT_IDS.length > 0) {
      for (const pid of PROJECT_IDS) {
        const page = await redmineGet("/issues.json", { ...params, project_id: pid });
        const pageIssues = page.issues || [];
        results.push(...pageIssues);
      }
    } else {
      const page = await redmineGet("/issues.json", params);
      const pageIssues = page.issues || [];
      results.push(...pageIssues);
      const total = page.total_count ?? pageIssues.length;
      if (offset + limit >= total) break;
    }

    offset += limit;
    if (offset >= 1000) break;

    const last = results[results.length - 1];
    if (!last) break;
    const lastUpdated = new Date(last.updated_on);
    if (lastUpdated < startUTC) break;
  }

  // Filter to range
  return results.filter(it => {
    const upd = new Date(it.updated_on);
    return upd >= startUTC && upd <= endUTC;
  });
}

async function fetchIssuesCreatedBetween(startUTC, endUTC) {
  // We can query by created_on desc too
  const results = [];
  const limit = 100;
  let offset = 0;
  const paramsCommon = { status_id: "*", sort: "created_on:desc", limit };

  while (true) {
    const params = { ...paramsCommon, offset };
    if (PROJECT_IDS.length > 0) {
      for (const pid of PROJECT_IDS) {
        const page = await redmineGet("/issues.json", { ...params, project_id: pid });
        results.push(...(page.issues || []));
      }
    } else {
      const page = await redmineGet("/issues.json", params);
      results.push(...(page.issues || []));
      const total = page.total_count ?? (page.issues || []).length;
      if (offset + limit >= total) break;
    }
    offset += limit;
    if (offset >= 1000) break;
    const last = results[results.length - 1];
    if (!last) break;
    const lastCreated = new Date(last.created_on);
    if (lastCreated < startUTC) break;
  }

  return results.filter(it => {
    const created = new Date(it.created_on);
    return created >= startUTC && created <= endUTC;
  });
}

async function fetchIssuesClosedBetween(startUTC, endUTC) {
  // closed_on is present only once closed; we'll page by closed_on desc is not supported, so use updated_on desc and filter
  const updated = await fetchIssuesUpdatedSince(startUTC, endUTC);
  return updated.filter(it => it.closed_on && (new Date(it.closed_on) >= startUTC) && (new Date(it.closed_on) <= endUTC));
}

async function fetchIssuesDueSoon(fromUTC, toUTC) {
  // Pull upcoming due_date issues by updated_on desc and filter by due_date window
  const updated = await fetchIssuesUpdatedSince(fromUTC, toUTC);
  return updated.filter(it => it.due_date && (new Date(it.due_date) >= fromUTC) && (new Date(it.due_date) <= toUTC));
}

async function fetchTimeEntries(dateStartYMD, dateEndYMD) {
  const results = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    if (PROJECT_IDS.length > 0) {
      // Loop projects to narrow
      for (const pid of PROJECT_IDS) {
        const page = await redmineGet("/time_entries.json", { from: dateStartYMD, to: dateEndYMD, limit, offset, project_id: pid });
        results.push(...(page.time_entries || []));
      }
    } else {
      const page = await redmineGet("/time_entries.json", { from: dateStartYMD, to: dateEndYMD, limit, offset });
      results.push(...(page.time_entries || []));
      const total = page.total_count ?? (page.time_entries || []).length;
      if (offset + limit >= total) break;
    }
    offset += limit;
    if (offset >= 1000) break;
  }
  return results;
}

function aggregateTimeEntries(entries) {
  const byProject = new Map();
  const byUser = new Map();
  for (const te of entries) {
    const hours = Number(te.hours || 0);
    const proj = te.project?.name || `#${te.project?.id || "?"}`;
    const user = te.user?.name || `#${te.user?.id || "?"}`;
    byProject.set(proj, (byProject.get(proj) || 0) + hours);
    byUser.set(user, (byUser.get(user) || 0) + hours);
  }
  const topProjects = [...byProject.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topUsers = [...byUser.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
  const total = [...byProject.values()].reduce((a,b)=>a+b,0);
  return { topProjects, topUsers, total };
}

function mdList(items) {
  return items.map(([name, val]) => `- ${name}: ${val.toFixed(2)} h`).join("\n");
}

async function maybePostToSlack(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error("Slack webhook failed:", await res.text());
  } catch (e) {
    console.error("Slack webhook error:", e.message);
  }
}

async function sendEmailResend(subject, text) {
  if (!RESEND_API_KEY || !EMAIL_FROM || EMAIL_TO.length === 0) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: EMAIL_TO,
        subject,
        text
      })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('Resend email failed:', res.status, res.statusText, t);
      return false;
    }
    console.log('Resend email sent');
    return true;
  } catch (e) {
    console.error('Resend email error:', e.message);
    return false;
  }
}

async function sendEmailSMTP(subject, text) {
  if (!nodemailer || !SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM || EMAIL_TO.length === 0) return false;
  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    const info = await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO.join(','), subject, text });
    console.log('SMTP email sent:', info.messageId || 'ok');
    return true;
  } catch (e) {
    console.error('SMTP send error:', e.message);
    return false;
  }
}

(async function main() {
  try {
    const { startUTC, endUTC } = getLocalDayRange(DAYS_BACK, REPORT_TZ_OFFSET);
    const ymdStart = toYYYYMMDD(startUTC);
    const ymdEnd = toYYYYMMDD(endUTC);

    const dueSoonFromUTC = endUTC; // desde el comienzo de hoy local
    const dueSoonToUTC = new Date(endUTC.getTime() + DUE_SOON_DAYS * 24 * 3600 * 1000);

    const [issuesCreated, issuesUpdated, issuesClosed, timeEntries, dueSoon] = await Promise.all([
      fetchIssuesCreatedBetween(startUTC, endUTC),
      fetchIssuesUpdatedSince(startUTC, endUTC),
      fetchIssuesClosedBetween(startUTC, endUTC),
      fetchTimeEntries(ymdStart, ymdEnd),
      fetchIssuesDueSoon(dueSoonFromUTC, dueSoonToUTC),
    ]);

    const timeAgg = aggregateTimeEntries(timeEntries);

    const title = `Redmine Diario (${ymdStart})`;
    const lines = [];
    lines.push(`# ${title}`);
    lines.push(`Base: ${BASE_URL}`);
    if (PROJECT_IDS.length) lines.push(`Proyectos: ${PROJECT_IDS.join(", ")}`);
    lines.push("");
    lines.push(`Issues creados: ${issuesCreated.length}`);
    lines.push(`Issues actualizados: ${issuesUpdated.length}`);
    lines.push(`Issues cerrados: ${issuesClosed.length}`);
    lines.push("");
    lines.push(`Horas totales: ${timeAgg.total.toFixed(2)} h`);
    if (timeAgg.topProjects.length) {
      lines.push("Top proyectos por horas:");
      lines.push(mdList(timeAgg.topProjects));
    }
    if (timeAgg.topUsers.length) {
      lines.push("");
      lines.push("Top usuarios por horas:");
      lines.push(mdList(timeAgg.topUsers));
    }

    if (dueSoon.length) {
      lines.push("");
      lines.push(`Vencen pronto (próximos ${DUE_SOON_DAYS} días): ${dueSoon.length}`);
      // Mostrar hasta 10
      const topDue = dueSoon
        .sort((a,b) => new Date(a.due_date) - new Date(b.due_date))
        .slice(0, 10)
        .map(it => `- #${it.id} ${it.subject} (due: ${it.due_date})`);
      lines.push(topDue.join("\n"));
    }

    const md = lines.join("\n");
    console.log(md);
    await maybePostToSlack(md);

    const subject = `${EMAIL_SUBJECT_PREFIX} ${ymdStart}`;
    // Try SMTP first, fallback to Resend HTTP if configured
    let sent = await sendEmailSMTP(subject, md);
    if (!sent) {
      sent = await sendEmailResend(subject, md);
    }
    if (!sent) {
      console.error('No email providers succeeded (SMTP/Resend).');
    }
  } catch (e) {
    console.error("Report failed:", e.stack || e.message);
    process.exit(1);
  }
})();


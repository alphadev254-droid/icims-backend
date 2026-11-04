import type { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import prisma from '../lib/prisma';
import { queueEmail } from '../lib/emailQueue';
import { calculateNextReportRun, REPORT_DEFINITIONS, ReportType } from '../lib/reportAutomation';
import { getUsers } from '../controllers/userController';
import { getDonations } from '../controllers/givingController';
import { getMinistryPledges } from '../controllers/pledgeController';
import { getAttendance, getServiceVisitorsReport } from '../controllers/attendanceController';
import { getCells, getCellVisitors } from '../controllers/cellController';
import { exportTransactions, getGivingByMember } from '../controllers/transactionController';
import { scheduledReportTemplate } from '../lib/emailTemplates';

type AutomationRow = Awaited<ReturnType<typeof prisma.reportAutomation.findUniqueOrThrow>>;
type JsonMap = Record<string, any>;

const handlers: Record<ReportType, (req: Request, res: Response) => Promise<void>> = {
  membership: getUsers, giving: getDonations, giving_by_member: getGivingByMember,
  pledges: getMinistryPledges, attendance: getAttendance, cell_groups: getCells,
  cell_visitors: getCellVisitors, church_visitors: getServiceVisitorsReport, transactions: exportTransactions,
};

function localDate(now: Date, timezone: string) {
  return new Date(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now) + 'T00:00:00Z');
}

function reportPeriod(preset: string, timezone: string, now = new Date()) {
  const end = localDate(now, timezone);
  const start = new Date(end);
  if (preset === 'previous_week') { start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7) - 7); end.setTime(start.getTime()); end.setUTCDate(end.getUTCDate() + 6); }
  else if (preset === 'previous_month') { start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 1); end.setUTCDate(0); }
  else if (preset === 'current_month_to_date') start.setUTCDate(1);
  else if (preset === 'last_30_days') start.setUTCDate(start.getUTCDate() - 29);
  else { const quarterStart = Math.floor(start.getUTCMonth() / 3) * 3; start.setUTCMonth(quarterStart - 3, 1); end.setUTCFullYear(start.getUTCFullYear(), start.getUTCMonth() + 3, 0); }
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function flatten(value: JsonMap, prefix = '', result: JsonMap = {}) {
  for (const [key, item] of Object.entries(value)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (item == null || typeof item !== 'object' || item instanceof Date) result[label] = item instanceof Date ? item.toISOString() : item;
    else if (Array.isArray(item)) result[label] = item.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join('; ');
    else flatten(item, label, result);
  }
  return result;
}

async function callReportController(automation: AutomationRow) {
  const creator = await prisma.user.findUnique({ where: { id: automation.createdById }, include: { role: { select: { name: true } } } });
  if (!creator) throw new Error('The user who created this automation no longer exists');
  const filters = automation.filters as JsonMap;
  const query: JsonMap = { export: 'true', limit: '10000', page: '1', ...reportPeriod(automation.periodPreset, automation.timezone) };
  for (const [key, value] of Object.entries(filters)) if (value !== 'all' && value !== '' && !Array.isArray(value)) query[key] = String(value);
  if (automation.reportType === 'giving' || automation.reportType === 'pledges') query.groupByPersonCampaign = 'true';
  if (automation.reportType === 'giving_by_member') query.groupByCampaign = 'true';
  if (automation.reportType === 'cell_groups') query.includeTopInviters = 'true';
  if (automation.reportType === 'cell_visitors' || automation.reportType === 'church_visitors') query.groupByVisitor = 'true';
  let statusCode = 200; let payload: any;
  const req = { query, params: {}, body: {}, user: { userId: creator.id, email: creator.email, role: (creator.role?.name || 'member') as any, churchId: creator.churchId, permissions: [], regions: [], districts: [], traditionalAuthorities: [] }, get: (name: string) => name.toLowerCase() === 'x-timezone' ? automation.timezone : undefined } as unknown as Request;
  const res = { status(code: number) { statusCode = code; return this; }, json(body: any) { payload = body; return this; }, send(body: any) { payload = body; return this; } } as unknown as Response;
  await handlers[automation.reportType as ReportType](req, res);
  if (statusCode >= 400 || payload?.success === false) throw new Error(payload?.message || `Report query failed (${statusCode})`);
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return { rows: rows.map((row: JsonMap) => flatten(row)), period: reportPeriod(automation.periodPreset, automation.timezone) };
}

function workbookBuffer(automation: AutomationRow, rows: JsonMap[], period: { startDate: string; endDate: string }) {
  const book = XLSX.utils.book_new();
  const meta = XLSX.utils.aoa_to_sheet([['Report', automation.name], ['Period', `${period.startDate} to ${period.endDate}`], ['Timezone', automation.timezone], ['Generated', new Date().toISOString()], ['Records', rows.length]]);
  const data = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Message: 'No records matched this report scope and period.' }]);
  XLSX.utils.book_append_sheet(book, meta, 'Report information'); XLSX.utils.book_append_sheet(book, data, 'Data');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function recipientEmails(automation: AutomationRow) {
  const recipients = automation.recipients as unknown as { includeMinistryAdmin: boolean; userIds: string[]; emails: string[] };
  const ids = [...new Set([...(recipients.userIds || []), ...(recipients.includeMinistryAdmin ? [automation.ministryAdminId] : [])])];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, status: 'active' }, select: { email: true } }) : [];
  return [...new Set([...users.map(u => u.email), ...(recipients.emails || [])].map(e => e.trim().toLowerCase()).filter(Boolean))];
}

export async function executeReportAutomation(automationId: string, scheduledFor = new Date()) {
  const automation = await prisma.reportAutomation.findUniqueOrThrow({ where: { id: automationId } });
  const run = await prisma.reportAutomationRun.create({ data: { automationId, scheduledFor, status: 'processing' } });
  try {
    const { rows, period } = await callReportController(automation);
    const content = workbookBuffer(automation, rows, period);
    const emails = await recipientEmails(automation);
    if (!emails.length) throw new Error('No valid recipients are configured');
    const filename = `${automation.reportType}-${period.startDate}-to-${period.endDate}.xlsx`;
    const label = REPORT_DEFINITIONS[automation.reportType as ReportType].label;
    const html = scheduledReportTemplate({
      reportName: label,
      startDate: period.startDate,
      endDate: period.endDate,
      timeZone: automation.timezone,
    });
    await Promise.all(emails.map(to => queueEmail(to, `${label}: ${period.startDate} to ${period.endDate}`, html, [{ filename, content, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentDisposition: 'attachment' }], 'notification')));
    await prisma.$transaction([
      prisma.reportAutomationRun.update({ where: { id: run.id }, data: { status: 'queued', recipientCount: emails.length, fileName: filename, completedAt: new Date() } }),
      prisma.reportAutomation.update({ where: { id: automation.id }, data: { lastRunAt: new Date(), lastStatus: 'queued', lastError: null } }),
    ]);
    return { runId: run.id, recipientCount: emails.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Report delivery failed';
    await prisma.$transaction([
      prisma.reportAutomationRun.update({ where: { id: run.id }, data: { status: 'failed', error: message, completedAt: new Date() } }),
      prisma.reportAutomation.update({ where: { id: automation.id }, data: { lastRunAt: new Date(), lastStatus: 'failed', lastError: message } }),
    ]);
    throw error;
  }
}

export async function claimDueReportAutomations(now = new Date()) {
  const due = await prisma.reportAutomation.findMany({ where: { isActive: true, nextRunAt: { lte: now } }, orderBy: { nextRunAt: 'asc' }, take: 20 });
  const claimed: string[] = [];
  for (const automation of due) {
    const nextRunAt = calculateNextReportRun({ frequency: automation.frequency as any, dayOfWeek: automation.dayOfWeek, dayOfMonth: automation.dayOfMonth, timeOfDay: automation.timeOfDay, timezone: automation.timezone, isActive: true }, now);
    const result = await prisma.reportAutomation.updateMany({ where: { id: automation.id, nextRunAt: automation.nextRunAt }, data: { nextRunAt } });
    if (result.count) claimed.push(automation.id);
  }
  return claimed;
}

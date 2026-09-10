import axios from 'axios';
import { PayoutProvider, ProviderPayout, ProviderPayoutStatus, ProviderPayoutTransaction } from './types';

const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';

function paystackHeaders() {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  return { Authorization: `Bearer ${secret}` };
}

function money(value: unknown): number {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric / 100) * 100) / 100;
}

function status(value: unknown): ProviderPayoutStatus {
  switch (String(value || '').toLowerCase()) {
    case 'success': return 'completed';
    case 'failed': return 'failed';
    case 'processing': return 'processing';
    default: return 'pending';
  }
}

async function fetchAll(url: string, params: Record<string, unknown> = {}): Promise<any[]> {
  const rows: any[] = [];
  let page = 1;
  let pageCount = 1;
  do {
    const response = await axios.get(url, {
      headers: paystackHeaders(),
      params: { ...params, perPage: 100, page },
      timeout: 30_000,
    });
    rows.push(...(Array.isArray(response.data?.data) ? response.data.data : []));
    pageCount = Math.max(1, Number(response.data?.meta?.pageCount || 1));
    page += 1;
  } while (page <= pageCount);
  return rows;
}

export const paystackPayoutProvider: PayoutProvider = {
  async listPayouts({ providerAccountId, from, to }): Promise<ProviderPayout[]> {
    const rows = await fetchAll(`${PAYSTACK_BASE_URL}/settlement`, {
      subaccount: providerAccountId,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    return rows.map(row => ({
      externalId: String(row.id),
      status: status(row.status),
      currency: String(row.currency || '').toUpperCase(),
      grossAmount: money(row.total_processed),
      feeAmount: money(row.total_fees),
      deductionAmount: money(row.deductions),
      netAmount: money(row.effective_amount ?? row.total_amount),
      settlementDate: row.settlement_date ? new Date(row.settlement_date) : undefined,
      processedAt: row.status === 'success' && row.updatedAt ? new Date(row.updatedAt) : undefined,
      raw: row,
    }));
  },

  async listPayoutTransactions(externalPayoutId): Promise<ProviderPayoutTransaction[]> {
    const rows = await fetchAll(`${PAYSTACK_BASE_URL}/settlement/${encodeURIComponent(externalPayoutId)}/transactions`);
    return rows.map(row => ({
      externalId: String(row.id),
      reference: String(row.reference || ''),
      grossAmount: money(row.amount),
      currency: String(row.currency || '').toUpperCase(),
      raw: row,
    }));
  },

  async fetchAccount(idOrCode: string): Promise<any> {
    const response = await axios.get(`${PAYSTACK_BASE_URL}/subaccount/${encodeURIComponent(idOrCode)}`, {
      headers: paystackHeaders(),
      timeout: 30_000,
    });
    return response.data?.data;
  },
};

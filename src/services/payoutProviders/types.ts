export type ProviderPayoutStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'reversed';

export interface ProviderPayout {
  externalId: string;
  status: ProviderPayoutStatus;
  currency: string;
  grossAmount: number;
  feeAmount: number;
  deductionAmount: number;
  netAmount: number;
  settlementDate?: Date;
  processedAt?: Date;
  raw: unknown;
}

export interface ProviderPayoutTransaction {
  externalId: string;
  reference: string;
  grossAmount: number;
  currency: string;
  raw: unknown;
}

export interface PayoutProvider {
  listPayouts(input: { providerAccountId: string; from: Date; to: Date }): Promise<ProviderPayout[]>;
  listPayoutTransactions(externalPayoutId: string): Promise<ProviderPayoutTransaction[]>;
  fetchAccount(idOrCode: string): Promise<any>;
}

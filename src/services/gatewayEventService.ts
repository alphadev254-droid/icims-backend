import crypto from 'crypto';
import prisma from '../lib/prisma';

export async function recordGatewayEvent(input: {
  payoutId?: string;
  gateway: string;
  resourceType: string;
  eventType: string;
  externalId?: string;
  externalReference?: string;
  payload: unknown;
  processingError?: string;
}) {
  const serialized = JSON.stringify(input.payload ?? null);
  const payloadHash = crypto.createHash('sha256').update(serialized).digest('hex');
  const eventKey = crypto.createHash('sha256').update([
    input.gateway, input.resourceType, input.eventType,
    input.externalId || '', input.externalReference || '', payloadHash,
  ].join('|')).digest('hex');

  return prisma.gatewayEvent.upsert({
    where: { eventKey },
    create: {
      payoutId: input.payoutId,
      gateway: input.gateway,
      resourceType: input.resourceType,
      eventType: input.eventType,
      externalId: input.externalId,
      externalReference: input.externalReference,
      eventKey,
      payloadHash,
      payload: input.payload as any,
      processedAt: input.processingError ? null : new Date(),
      processingError: input.processingError,
    },
    update: {},
  });
}

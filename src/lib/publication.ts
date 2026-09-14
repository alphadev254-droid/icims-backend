export type PublicationFields = {
  publicationStatus: 'draft' | 'published';
  publishAt: Date | null;
  publishedAt: Date | null;
};

export function publicationForStart(startAt: Date, leadDays?: number): PublicationFields {
  const configured = leadDays ?? Number(process.env.SCHEDULE_PUBLICATION_LEAD_DAYS || 30);
  const safeLeadDays = Number.isFinite(configured) ? Math.max(0, Math.min(365, configured)) : 30;
  const publishAt = new Date(startAt.getTime() - safeLeadDays * 86_400_000);
  const now = new Date();
  if (publishAt <= now) return { publicationStatus: 'published', publishAt, publishedAt: now };
  return { publicationStatus: 'draft', publishAt, publishedAt: null };
}

export function communicationPublication(scheduled: boolean) {
  return scheduled
    ? { publicationStatus: 'draft' as const, publishedAt: null }
    : { publicationStatus: 'published' as const, publishedAt: new Date() };
}

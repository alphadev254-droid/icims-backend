import { Request, Response } from 'express';
import prisma from '../lib/prisma';

export async function getRegions(req: Request, res: Response): Promise<void> {
  const regions = await prisma.location.findMany({
    select: { region: true },
    distinct: ['region'],
    orderBy: { region: 'asc' }
  });
  res.json({ success: true, data: regions.map(r => r.region) });
}

export async function getDistricts(req: Request, res: Response): Promise<void> {
  const { region } = req.params;
  const districts = await prisma.location.findMany({
    where: { region },
    select: { district: true },
    distinct: ['district'],
    orderBy: { district: 'asc' }
  });
  res.json({ success: true, data: districts.map(d => d.district) });
}

export async function getTraditionalAuthorities(req: Request, res: Response): Promise<void> {
  const { region, district } = req.params;
  const tas = await prisma.location.findMany({
    where: { region, district },
    select: { traditionalAuthority: true },
    distinct: ['traditionalAuthority'],
    orderBy: { traditionalAuthority: 'asc' }
  });
  res.json({ success: true, data: tas.map(ta => ta.traditionalAuthority) });
}

export async function getVillages(req: Request, res: Response): Promise<void> {
  const { region, district, traditionalAuthority } = req.params;
  const villages = await prisma.location.findMany({
    where: { region, district, traditionalAuthority },
    select: { village: true },
    distinct: ['village'],
    orderBy: { village: 'asc' }
  });
  res.json({ success: true, data: villages.map(v => v.village) });
}
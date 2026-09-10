import { Request, Response } from 'express';
import { reconcilePaystackSettlements } from '../services/settlementReconciliationService';

export async function reconcilePaystackPayouts(req: Request, res: Response): Promise<void> {
  const parsedFrom = req.body?.from ? new Date(String(req.body.from)) : undefined;
  const parsedTo = req.body?.to ? new Date(String(req.body.to)) : undefined;
  if ((parsedFrom && Number.isNaN(parsedFrom.getTime())) || (parsedTo && Number.isNaN(parsedTo.getTime()))) {
    res.status(400).json({ success: false, message: 'from and to must be valid dates' });
    return;
  }
  const result = await reconcilePaystackSettlements({ from: parsedFrom, to: parsedTo });
  res.json({ success: true, data: result });
}

import { z } from 'zod';

export const phoneSchema = z.string()
  .trim()
  .regex(/^\+?\d+$/, 'Phone number can only contain digits and an optional leading +')
  .min(7, 'Enter a valid phone number')
  .max(16, 'Enter a valid phone number');

export const optionalPhoneSchema = z.string()
  .trim()
  .regex(/^\+?\d*$/, 'Phone number can only contain digits and an optional leading +')
  .max(16, 'Enter a valid phone number')
  .optional()
  .or(z.literal(''));

export const digitsOnlySchema = (label: string) =>
  z.string().trim().regex(/^\d+$/, `${label} can only contain digits`);

export const optionalDigitsOnlySchema = (label: string) =>
  z.string().trim().regex(/^\d*$/, `${label} can only contain digits`).optional().or(z.literal(''));

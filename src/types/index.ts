export type UserRole =
  | 'system_admin'
  | 'ministry_admin'
  | 'member';

export type PackageTier = 'basic' | 'standard' | 'premium';
export type ChurchLevel = 'national' | 'regional' | 'district' | 'local';

export interface JwtPayload {
  userId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  userName?: string;
  role: UserRole;         // convenience role name string
  churchId: string | null;
  permissions: string[];
  accountCountry?: string;           // Country name used to resolve pricing markets and gateway routing
  // Geographic scope — determines which churches this user accesses
  regions?: string[];
  districts?: string[];
  traditionalAuthorities?: string[];
}

// Extend Express Request to include authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export type UserRole =
  | 'national_admin'
  | 'regional_leader'
  | 'district_overseer'
  | 'local_admin'
  | 'member';

export type PackageTier = 'basic' | 'standard' | 'premium';
export type ChurchLevel = 'national' | 'regional' | 'district' | 'local';

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;         // convenience role name string
  churchId: string | null;
  permissions: string[];
  // Geographic scope — determines which churches this user accesses
  regions?: string[];                // regional_leader: ["Central","Northern"] or ["__all__"]
  districts?: string[];              // district_overseer: ["Lilongwe","Dedza"] or ["__all__"]
  traditionalAuthorities?: string[]; // local_admin: ["Kalumbu","Njewa"] or ["__all__"]
}

// Extend Express Request to include authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

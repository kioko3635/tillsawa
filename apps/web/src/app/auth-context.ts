import { createContext } from 'react';
import type { LoginInput, RegisterOrganizationInput } from '@pos/contracts';
import type { AuthMembership, Bootstrap } from '../lib/api/types';

export interface AuthState {
  status: 'loading' | 'anonymous' | 'authenticated';
  membership: AuthMembership | null;
  bootstrap: Bootstrap | null;
  login: (input: LoginInput) => Promise<void>;
  registerOrganization: (input: RegisterOrganizationInput, setupKey?: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
}

export const AuthContext = createContext<AuthState | null>(null);

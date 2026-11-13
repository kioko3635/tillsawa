import { createContext, useContext } from 'react';
import type { SubscriptionStatus } from '../../lib/api/types';

export const SubscriptionContext = createContext<{ status: SubscriptionStatus | null; refresh: () => Promise<void> }>({ status: null, refresh: async () => {} });
export const useSubscription = () => useContext(SubscriptionContext);

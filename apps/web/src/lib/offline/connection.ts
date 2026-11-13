import { useEffect, useState } from 'react';

const modes = ['standalone', 'server', 'terminal', 'cloud', 'hub'] as const;
export type DeploymentMode = typeof modes[number] | 'checking';
type Connection = { mode: DeploymentMode; registrationOpen: boolean };

export function useDeploymentConnection(): Connection {
  const [connection, setConnection] = useState<Connection>(() => {
    try {
      // Retain offline cash checkout only for a previously verified standalone origin.
      return { mode: localStorage.getItem('kenya-pos.deployment-mode') === 'standalone' ? 'standalone' : 'checking', registrationOpen: false };
    } catch { return { mode: 'checking', registrationOpen: false }; }
  });
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/v1/local/connection', { cache: 'no-store', signal: controller.signal }).then(response => response.json()).then(result => {
      if (controller.signal.aborted || !modes.includes(result.data?.mode)) return;
      setConnection({ mode: result.data.mode, registrationOpen: result.data.registrationOpen === true });
      try { localStorage.setItem('kenya-pos.deployment-mode', result.data.mode); } catch { /* Browser storage is optional. */ }
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  return connection;
}

export function useDeploymentMode(): DeploymentMode { return useDeploymentConnection().mode; }

export const deploymentLabels: Record<DeploymentMode, string> = {
  standalone: 'Local shop', server: 'Shared shop server', terminal: 'Connected till', cloud: 'Cloud workspace', hub: 'Reporting hub', checking: 'Checking connection'
};

export function useOnlineStatus(): boolean {
  // Internet connectivity is independent of a shop's localhost server.
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    const check = async () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const timeout = window.setTimeout(() => current.abort(), 4000);
      try {
        const response = await fetch('/api/v1/health/ready', { cache: 'no-store', signal: current.signal });
        if (!disposed && controller === current) setOnline(response.ok);
      } catch {
        if (!disposed && controller === current) setOnline(false);
      } finally {
        window.clearTimeout(timeout);
      }
    };
    void check();
    const interval = window.setInterval(() => void check(), 15000);
    const recheck = () => void check();
    window.addEventListener('online', recheck);
    window.addEventListener('offline', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener('online', recheck);
      window.removeEventListener('offline', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, []);
  return online;
}

export function registerServiceWorker(): void {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    });
  }
}

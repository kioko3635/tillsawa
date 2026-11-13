import { desktopAccessToken } from './api/client';

type DesktopView = { postMessage: (message: string) => void; addEventListener: (event: 'message', callback: (event: { data: unknown }) => void) => void; removeEventListener: (event: 'message', callback: (event: { data: unknown }) => void) => void };
function view(): DesktopView | undefined { return (window as unknown as { __TILLSAWA_DESKTOP__?: boolean; chrome?: { webview?: DesktopView } }).__TILLSAWA_DESKTOP__ ? (window as unknown as { chrome?: { webview?: DesktopView } }).chrome?.webview : undefined; }
export function desktopAvailable() { return !!view(); }
export interface TillHardware { settings: { enabled: boolean; printer: string; pin: number }; printers: string[]; }
export function desktopRequest<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
  const bridge = view(); if (!bridge) return Promise.reject(new Error('Open this feature in the installed TillSawa Windows application on the physical till.'));
  const channel: DesktopView = bridge;
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { channel.removeEventListener('message', receive); reject(new Error('The printer request is still unconfirmed. The sale remains recorded; do not repeat checkout.')); }, 20000);
    function receive(event: { data: unknown }) {
      const message = event.data as { requestId?: string; ok?: boolean; error?: string; result?: T };
      if (!message || message.requestId !== requestId) return;
      window.clearTimeout(timer); channel.removeEventListener('message', receive);
      if (message.ok) resolve(message.result as T); else reject(new Error(message.error || 'The hardware request could not complete.'));
    }
    channel.addEventListener('message', receive);
    channel.postMessage(JSON.stringify({ ...input, action, requestId, token: desktopAccessToken() }));
  });
}

const paths: Record<string, string> = {
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  pos: 'M3 4h18v12H3zM8 21h8M12 16v5M6 8h5M6 11h8M17 8v4',
  inventory: 'M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10M7 5l10 4',
  catalogue: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  reports: 'M4 3v18h17M8 16v-5M13 16V7M18 16v-9',
  procurement: 'M3 7h11v11H3zM14 11h4l3 4v3h-7M6 18a2 2 0 1 0 4 0M15 18a2 2 0 1 0 4 0M6 4h6',
  credit: 'M3 6h18v14H3zM3 10h18M7 15h4M16 3v3',
  expenses: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h3',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 4a4 4 0 0 1 0 7M22 21v-2a4 4 0 0 0-3-3.9',
  branches: 'M4 21V5h10v16M14 10h6v11M8 9h2M8 13h2M8 17h2M3 21h18',
  stores: 'M3 4h7v7H3zM14 4h7v7h-7zM9 16h6v5H9zM6 11v3h12v-3M12 14v2',
  organization: 'M4 21V5l8-2v18M12 8h8v13M7 8h2M7 12h2M7 16h2M15 12h2M15 16h2M2 21h20',
  configuration: 'M4 7h16M4 17h16M9 4v6M15 14v6',
  roles: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6',
  devices: 'M4 3h16v14H4zM9 21h6M12 17v4M8 13h8',
  sessions: 'M12 8v5l3 2M4 7V3M4 3h4M4 3l3 3M4 12a8 8 0 1 0 4-7',
  subscription: 'M3 5h18v15H3zM3 10h18M7 15h3M15 15h2',
  audit: 'M8 4H4v17h16V4h-4M8 3h8v4H8zM8 11h8M8 15h6',
  scan: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M7 7v10M11 7v10M14 7v10M17 7v10',
  cash: 'M3 6h18v12H3zM6 9h1m10 6h1M14 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0z',
  'mobile-payment': 'M7 3h10v18H7zM10 6h4M11 18h2',
  bag: 'M5 7h14l1 14H4zM9 8V6a3 3 0 0 1 6 0v2',
  arrow: 'M5 12h14M14 7l5 5-5 5',
  search: 'M16 16l5 5M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13',
};
export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.configuration} /></svg>;
}

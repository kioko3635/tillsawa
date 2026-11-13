import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '../../design-system/components';
import { api } from '../../lib/api/client';

export function RecoverySetupReminder() {
  const [missing, setMissing] = useState(false);
  useEffect(() => { let cancelled = false; void api.recoveryStatus().then(result => { if (!cancelled) setMissing(result.remaining === 0); }).catch(() => undefined); return () => { cancelled = true; }; }, []);
  return missing ? <div className="no-print" style={{ marginBottom: 16 }}><Alert tone="warning">Prepare password recovery before handing over the shop. <Link to="/settings/security">Generate and save your private recovery codes</Link>.</Alert></div> : null;
}

import { Link } from 'react-router-dom';
import { Alert, Card, PageHeader } from '../design-system/components';
import { landingPath, type AccessSubject } from './access';
import { useAuth } from './useAuth';

/**
 * Shown when an authenticated member reaches a screen their permissions or the
 * organization's enabled modules do not allow. The backend enforces the same
 * rules — this is a clear landing point, not the security boundary.
 */
export function NoAccessPage() {
  const { membership, bootstrap } = useAuth();
  const subject: AccessSubject = {
    hasPermission: (permission) => Boolean(membership?.permissions.includes(permission)),
    hasModule: (moduleCode) => Boolean(bootstrap?.modules.includes(moduleCode))
  };

  return (
    <div className="page-stack">
      <PageHeader title="Access restricted" description="This area is not available to your account." />
      <Card>
        <Alert tone="warning">
          You do not have permission to view this page. If your role recently changed, sign out and back in to refresh your access.
        </Alert>
        <p>
          <Link className="btn btn-primary" to={landingPath(subject)}>Go to my workspace</Link>
        </p>
      </Card>
    </div>
  );
}

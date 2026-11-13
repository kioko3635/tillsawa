import { Badge, Card, EmptyState, PageHeader } from '../../design-system/components';

export function FutureModulePage({ title, phase, description }: { title: string; phase: string; description: string }) {
  return (
    <div className="page-stack">
      <PageHeader title={title} description={description} actions={<Badge tone="info">{phase}</Badge>} />
      <Card>
        <EmptyState
          title={`${title} is not implemented yet`}
          description="This page is intentionally marked as a future module and does not display simulated operational data."
        />
      </Card>
    </div>
  );
}

import { Link, useLocation } from 'react-router-dom';
import { Compass, Home, ShieldQuestion } from 'lucide-react';
import { useDocumentTitle } from '../lib/hooks';
import { Button, Card } from '../components/ui';
import { PageHeader } from '../components/common';

export function NotFoundPage() {
  useDocumentTitle('Not found');
  const location = useLocation();

  return (
    <div className="fade-in">
      <PageHeader
        title="Page not found"
        description="This route does not exist in the local ZetHub Proof workspace."
        icon={<ShieldQuestion className="h-5 w-5" />}
      />
      <Card className="mx-auto max-w-xl p-8 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-line bg-ink-800 text-accent-soft">
          <Compass className="h-6 w-6" />
        </div>
        <div className="mt-4 text-lg font-semibold text-white">Nowhere to verify here</div>
        <p className="mx-auto mt-2 max-w-sm text-[12.5px] leading-relaxed text-muted">
          <span className="font-mono text-slate-400">{location.pathname}</span> is not a ZetHub Proof route. Use the
          navigation, or return to the verification dashboard.
        </p>
        <div className="mt-5 flex justify-center">
          <Link to="/">
            <Button>
              <Home className="h-4 w-4" /> Back to dashboard
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}

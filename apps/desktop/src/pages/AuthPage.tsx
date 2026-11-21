import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Database,
  Eye,
  EyeOff,
  Fingerprint,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { errorMessage, useDocumentTitle } from '../lib/hooks';
import type { AuthStatus } from '../types';
import { useAuth } from '../providers/AuthProvider';
import { Alert, Button, Field, Input, Switch } from '../components/ui';

const FEATURES = [
  {
    icon: Fingerprint,
    title: 'Detects the real stack',
    text: 'Languages, package managers, test runners and build tools are probed on disk — never guessed.',
  },
  {
    icon: Terminal,
    title: 'Runs and records proof',
    text: 'Commands, browser journeys, API contracts and database checks execute locally with auditable evidence.',
  },
  {
    icon: Workflow,
    title: 'Filters noise',
    text: 'Failure capsules, repair–retest and quality audits keep conversations grounded in captured output.',
  },
  {
    icon: Database,
    title: 'Safe XAMPP workflow',
    text: 'Backups, migrations and health checks with explicit approvals. No destructive reset buttons.',
  },
];

export function AuthPage() {
  useDocumentTitle('Sign in');
  const { initialized, login, bootstrap, error: authError } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = React.useState<AuthStatus | null>(null);
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [remember, setRemember] = React.useState(true);
  const [showPassword, setShowPassword] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .get<AuthStatus>('/api/v1/auth/status')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const setup = !initialized;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (setup) await bootstrap(name.trim(), email.trim(), password);
      else await login(email.trim(), password, remember);
      toast.success(setup ? 'Owner account created. Welcome to ZetHub Proof.' : 'Signed in.');
      navigate('/', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.15fr_minmax(430px,0.85fr)]">
      <section className="relative hidden overflow-hidden border-r border-line bg-grid-faint lg:flex lg:flex-col lg:justify-between">
        <div className="absolute inset-0 bg-gradient-to-br from-accent/10 via-transparent to-cyan/5" />
        <div className="relative p-10 xl:p-14">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-accent to-accent-deep shadow-glow">
              <ShieldCheck className="h-6 w-6 text-white" />
            </span>
            <div>
              <div className="text-[17px] font-semibold tracking-tight text-white">ZetHub Proof</div>
              <div className="text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500">
                Verification platform
              </div>
            </div>
          </div>

          <div className="mt-16 max-w-xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-[11px] font-medium text-accent-soft">
              <Sparkles className="h-3.5 w-3.5" /> AI writes the code. ZetHub Proof proves it works.
            </div>
            <h1 className="mt-5 text-[38px] font-semibold leading-[1.1] tracking-tight text-white xl:text-[46px]">
              Evidence for every
              <span className="bg-gradient-to-r from-accent-soft to-cyan bg-clip-text text-transparent">
                {' '}
                “it works on my machine”.
              </span>
            </h1>
            <p className="mt-5 max-w-lg text-[13.5px] leading-relaxed text-slate-400">
              A local-first developer verification platform that detects your stack, executes the right checks, captures
              reproducible evidence and reports only what was actually verified.
            </p>
          </div>

          <div className="mt-12 grid max-w-xl gap-3 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="rounded-xl border border-line-soft bg-ink-900/55 p-4 backdrop-blur-sm"
              >
                <feature.icon className="h-4 w-4 text-accent-soft" />
                <div className="mt-2.5 text-[12.5px] font-semibold text-slate-200">{feature.title}</div>
                <div className="mt-1 text-[11.5px] leading-relaxed text-slate-500">{feature.text}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative border-t border-line-soft px-10 py-5 text-[10.5px] text-slate-600 xl:px-14">
          Loopback-only API · encrypted credentials at rest · explicit approvals · signed evidence manifests
        </div>
      </section>

      <section className="flex items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-[420px]">
          <div className="mb-7 flex items-center gap-3 lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-deep">
              <ShieldCheck className="h-5 w-5 text-white" />
            </span>
            <div>
              <div className="text-[15px] font-semibold text-white">ZetHub Proof</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Proof, not promises</div>
            </div>
          </div>

          <div className="panel p-6 sm:p-7">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-white">
                  {setup ? 'Create the local owner' : 'Welcome back'}
                </h2>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                  {setup
                    ? 'This account controls this installation. It is stored only in your local database.'
                    : 'Sign in to your local verification workspace.'}
                </p>
              </div>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-ink-800 text-accent-soft">
                {setup ? <LockKeyhole className="h-4 w-4" /> : <Fingerprint className="h-4 w-4" />}
              </span>
            </div>

            {status ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="chip">
                  <span className={`h-1.5 w-1.5 rounded-full ${status.dbReachable ? 'bg-positive' : 'bg-warning'}`} />
                  {status.dbReachable ? 'Database reachable' : 'Database unavailable'}
                </span>
                <span className="chip">v{status.version}</span>
                <span className="chip">{setup ? 'First-run setup' : 'Owner sign-in'}</span>
              </div>
            ) : null}

            {authError ? (
              <div className="mt-4">
                <Alert tone="danger" title="API problem">
                  {authError}
                </Alert>
              </div>
            ) : null}
            {error ? (
              <div className="mt-4">
                <Alert tone="danger" title="Could not continue">
                  {error}
                </Alert>
              </div>
            ) : null}

            <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
              {setup ? (
                <Field label="Display name">
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Local owner"
                    autoComplete="name"
                    required
                    maxLength={120}
                  />
                </Field>
              ) : null}
              <Field label="Email">
                <Input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@local"
                  aria-label="Email"
                  autoComplete="username"
                  required
                  maxLength={190}
                />
              </Field>
              <Field label="Password" hint={setup ? 'At least 10 characters with a letter and a number.' : undefined}>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="••••••••••"
                    aria-label="Password"
                    autoComplete={setup ? 'new-password' : 'current-password'}
                    required
                    minLength={setup ? 10 : undefined}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-slate-200"
                    onClick={() => setShowPassword((value) => !value)}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>

              {!setup ? (
                <Switch
                  checked={remember}
                  onCheckedChange={setRemember}
                  label="Keep this session"
                  description="Stay signed in on this device for 30 days."
                />
              ) : null}

              <Button
                type="submit"
                size="lg"
                className="w-full"
                loading={loading}
                disabled={!email || password.length < (setup ? 10 : 1) || (setup && !name)}
              >
                {setup ? 'Create owner account' : 'Sign in'} <ArrowRight className="h-4 w-4" />
              </Button>
            </form>

            <p className="mt-5 text-[10.5px] leading-relaxed text-slate-600">
              Credentials are verified locally using scrypt. Sessions are database-backed, cookies are HTTP-only, and
              state-changing requests require a CSRF token. No telemetry is sent.
            </p>
          </div>

          <p className="mt-5 text-center text-[10px] text-slate-600">ZetHub Proof · local-only build · 127.0.0.1</p>
        </div>
      </section>
    </div>
  );
}

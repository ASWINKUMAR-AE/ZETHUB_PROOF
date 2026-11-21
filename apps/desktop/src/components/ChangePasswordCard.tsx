import * as React from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { Alert, Button, Card, CardBody, CardHeader, Field, Input } from './ui';

export function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('The new password must differ from the current password.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/v1/auth/password', { currentPassword, newPassword });
      toast.success('Password changed. Other sessions were signed out.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Change password"
        description="Updates the password for your own account and signs out every other session."
        icon={<KeyRound className="h-4 w-4" />}
      />
      <CardBody>
        <form className="space-y-3" onSubmit={submit}>
          {error ? (
            <Alert tone="danger" title="Password not changed">
              {error}
            </Alert>
          ) : null}
          <Field label="Current password">
            <Input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
              maxLength={200}
            />
          </Field>
          <Field
            label="New password"
            hint="At least 10 characters. The local password policy also rejects common or repeated values."
          >
            <Input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={200}
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={200}
            />
          </Field>
          <Button type="submit" variant="secondary" className="w-full" loading={saving}>
            <ShieldCheck className="h-4 w-4" /> Change password
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

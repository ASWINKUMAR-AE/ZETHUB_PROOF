import * as React from 'react';
import { ArrowUp, Folder, HardDrive, Home, RotateCw, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Alert, Button, EmptyState, Input, LoadingBlock, Modal, Switch } from './ui';
import { cn } from '../lib/utils';

interface FsList {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
  drives: string[];
}

interface FsRoots {
  roots: Array<{ label: string; path: string; kind: string }>;
}

export function FolderPicker({
  open,
  onOpenChange,
  onSelect,
  initialPath,
  title = 'Choose a project folder',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  initialPath?: string;
  title?: string;
}) {
  const [current, setCurrent] = React.useState(initialPath ?? '');
  const [showHidden, setShowHidden] = React.useState(false);
  const [manual, setManual] = React.useState('');

  React.useEffect(() => {
    if (open) setCurrent(initialPath ?? '');
  }, [open, initialPath]);

  const roots = useAsync<FsRoots>(() => api.get<FsRoots>('/api/v1/fs/roots'), [open]);
  const listing = useAsync<FsList>(
    (signal) => {
      const params = new URLSearchParams();
      if (current) params.set('path', current);
      params.set('showHidden', showHidden ? 'true' : 'false');
      return api.get<FsList>(`/api/v1/fs/list?${params.toString()}`, signal);
    },
    [current, showHidden],
  );

  React.useEffect(() => {
    if (listing.data?.path) {
      setCurrent(listing.data.path);
      setManual(listing.data.path);
    }
  }, [listing.data?.path]);

  function choose(path: string) {
    setCurrent(path);
    setManual(path);
  }

  function goManual() {
    if (manual.trim()) setCurrent(manual.trim());
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Browse this machine. Only directories are listed; path traversal and symlinks are filtered by the API."
      width="2xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSelect(listing.data?.path ?? current);
              onOpenChange(false);
            }}
            disabled={!listing.data?.path}
          >
            Select this folder
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[210px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="label">Places</div>
          <div className="space-y-1">
            {(roots.data?.roots ?? []).map((root) => (
              <button
                key={root.path}
                onClick={() => choose(root.path)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition hover:bg-ink-800',
                  current === root.path ? 'bg-ink-800 text-white' : 'text-slate-400',
                )}
                title={root.path}
              >
                {root.kind === 'home' ? (
                  <Home className="h-3.5 w-3.5" />
                ) : root.kind === 'drive' ? (
                  <HardDrive className="h-3.5 w-3.5" />
                ) : (
                  <Folder className="h-3.5 w-3.5" />
                )}
                <span className="truncate">{root.label}</span>
              </button>
            ))}
            {roots.loading ? <div className="px-2 py-1 text-[11px] text-muted">Loading places…</div> : null}
          </div>
          {listing.data?.drives && listing.data.drives.length > 0 ? (
            <div>
              <div className="label mb-1.5">Drives</div>
              <div className="flex flex-wrap gap-1">
                {listing.data.drives.map((drive) => (
                  <button
                    key={drive}
                    className="chip hover:border-line-strong hover:text-white"
                    onClick={() => choose(drive)}
                  >
                    {drive}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <Switch checked={showHidden} onCheckedChange={setShowHidden} label="Hidden folders" />
        </div>

        <div className="min-w-0 space-y-3">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => listing.data?.parent && choose(listing.data.parent)}
              disabled={!listing.data?.parent}
              title="Parent folder"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" onClick={listing.reload} title="Refresh">
              <RotateCw className="h-4 w-4" />
            </Button>
            <Input
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') goManual();
              }}
              placeholder="C:\path\to\project"
              spellCheck={false}
            />
            <Button variant="secondary" onClick={goManual}>
              <Search className="h-3.5 w-3.5" /> Go
            </Button>
          </div>

          <div className="min-h-[300px] max-h-[360px] overflow-y-auto rounded-xl border border-line bg-ink-950/50">
            {listing.loading ? (
              <LoadingBlock label="Reading folder…" />
            ) : listing.error ? (
              <div className="p-4">
                <Alert tone="danger" title="Cannot open folder">
                  {listing.error}
                </Alert>
              </div>
            ) : !listing.data || listing.data.entries.length === 0 ? (
              <EmptyState
                title="No folders here"
                description="This directory has no visible subdirectories. You can still select it."
                icon={<Folder className="h-5 w-5" />}
                className="m-4"
              />
            ) : (
              <ul className="divide-y divide-line-soft">
                {listing.data.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[12.5px] text-slate-300 transition hover:bg-ink-800"
                      onClick={() => choose(entry.path)}
                      onDoubleClick={() => choose(entry.path)}
                    >
                      <Folder className="h-3.5 w-3.5 text-accent-soft" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="truncate rounded-lg border border-line-soft bg-ink-900/60 px-3 py-2 font-mono text-[11px] text-slate-400">
            {listing.data?.path || current || 'No folder selected'}
          </div>
        </div>
      </div>
    </Modal>
  );
}

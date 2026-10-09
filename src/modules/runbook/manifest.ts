import type { ModuleManifest } from '../registry/types'

export const runbookManifest: ModuleManifest = {
  id: 'runbook',
  name: 'Runbooks',
  summary: 'Save the checks you run after a deploy and run them in one click',
  description:
    'A runbook is a list of checks you save once and run in one click — after a deploy, before a ' +
    'maintenance window, when something feels wrong. Each step has its own target: check an HTTP ' +
    'health URL, run a command on an SSH server, wait for a Kubernetes Deployment to be ready, or ' +
    'make sure a Docker container is healthy. Steps run in order, stop at the first failure (unless ' +
    'you say otherwise) and show what passed and what did not.\n\n' +
    'On a production environment you type the runbook name before it runs, and commands never run ' +
    'on a read-only environment. Output that looks like a secret is hidden before it is shown or ' +
    'kept. Kubernetes and Docker steps appear when those modules are turned on.',
  category: 'servers',
  keywords: [
    'runbook',
    'checklist',
    'health check',
    'deploy',
    'verify',
    'smoke test',
    'post-deploy',
    'sre',
    'ops'
  ],
  source: 'builtin',
  since: '1.2.0',
  permissions: [
    {
      kind: 'ssh-exec',
      detail: 'Runs the commands of your runbooks on the SSH servers you pick for a step'
    },
    { kind: 'network', hosts: 'The web addresses you put in an HTTP check' },
    {
      kind: 'secrets',
      detail:
        'Stores the secret header values of HTTP checks (tokens, passwords) encrypted in the vault'
    },
    { kind: 'pick-file', detail: 'Reads the runbook files you choose to import' }
  ],
  version: 1,
  icon: 'list-checks',
  enabledByDefault: false,
  contributes: {
    sidebarSection: true,
    tabKinds: ['runbook'],
    sessionKinds: ['local'],
    attachToSsh: true
  }
}

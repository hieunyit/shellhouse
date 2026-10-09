import type { ModuleManifest } from '../registry/types'

export const dockerManifest: ModuleManifest = {
  id: 'docker',
  name: 'Docker',
  summary: 'Containers on this computer and on your servers over SSH — no open ports',
  description:
    'Manage containers, images, volumes, networks and Compose projects on this computer and on ' +
    'any server you reach with SSH. Shellhouse talks to the Docker socket through the SSH ' +
    'connection, so nothing has to be exposed on the network and nothing is installed on the ' +
    'server.\n\n' +
    'On Windows, Docker running inside WSL (Ubuntu, Debian…) is listed too.\n\n' +
    'Follow logs, watch CPU and memory, open a shell inside a container as a terminal tab, ' +
    'restart or remove containers, browse and copy files in and out of containers, build, pull, ' +
    'tag and push images (registry passwords are encrypted in your vault), create volumes and ' +
    'networks, and clean up disk space. Turn on read-only mode for production servers to hide ' +
    'every action that changes something.',
  category: 'containers',
  keywords: [
    'docker',
    'container',
    'compose',
    'podman',
    'image',
    'colima',
    'orbstack',
    'moby',
    'wsl'
  ],
  source: 'builtin',
  since: '1.2.0',
  permissions: [
    {
      kind: 'ssh-socket',
      path: '/var/run/docker.sock'
    },
    { kind: 'ssh-socket', path: '/run/docker.sock' },
    { kind: 'ssh-socket', path: '/run/user/*/docker.sock' },
    { kind: 'ssh-socket', path: '/run/user/*/podman/podman.sock' },
    {
      kind: 'ssh-exec',
      detail:
        'Runs `docker` on servers you open it for (Compose, image builds, private registries, and when the socket is not reachable)'
    },
    { kind: 'local-socket', path: '$DOCKER_HOST' },
    { kind: 'local-socket', path: '/var/run/docker.sock' },
    { kind: 'local-socket', path: '~/.docker/run/docker.sock' },
    { kind: 'local-socket', path: '~/.colima/*/docker.sock' },
    { kind: 'local-socket', path: '~/.orbstack/run/docker.sock' },
    { kind: 'local-socket', path: '/run/user/*/docker.sock' },
    { kind: 'local-socket', path: '/run/user/*/podman/podman.sock' },
    { kind: 'local-socket', path: '\\\\.\\pipe\\docker_engine' },
    { kind: 'run-program', binary: 'docker' },
    { kind: 'run-program', binary: 'trivy' },
    {
      kind: 'secrets',
      detail: 'Stores registry passwords and access tokens encrypted in the vault'
    },
    { kind: 'run-program', binary: 'wsl' }
  ],
  detect: [
    { on: 'ssh-connected', probe: 'unix-socket', path: '/var/run/docker.sock' },
    { on: 'startup', probe: 'local-socket', path: '/var/run/docker.sock' },
    { on: 'startup', probe: 'local-socket', path: '~/.docker/run/docker.sock' },
    { on: 'startup', probe: 'local-socket', path: '~/.orbstack/run/docker.sock' },
    { on: 'startup', probe: 'local-socket', path: '\\\\.\\pipe\\docker_engine' },
    { on: 'startup', probe: 'wsl-file', path: '/usr/bin/docker' }
  ],
  version: 1,
  icon: 'container',
  enabledByDefault: false,
  binaries: ['docker', 'trivy', 'wsl'],
  contributes: {
    sidebarSection: true,
    tabKinds: ['engine', 'logs'],
    hostActions: ['open'],
    commands: [{ id: 'open-local', title: 'Open Docker on this computer' }],
    settings: true,
    sessionKinds: ['engine', 'terminal'],
    attachToSsh: true,
    syncRecordTypes: ['docker_endpoint']
  }
}

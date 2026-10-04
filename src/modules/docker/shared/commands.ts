/**
 * "Copy as command" (thiết kế v0.7): lệnh docker CLI tương đương cho container — đúng endpoint:
 * máy này (không cờ), SSH (`docker -H ssh://user@host`), WSL (`wsl -d <distro> docker`).
 */
export interface DockerLine {
  id: string
  command: string
}

function q(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

export type DockerEndpoint =
  { kind: 'local' } | { kind: 'ssh'; address: string } | { kind: 'wsl'; distro: string }

/** Tiền tố lệnh docker cho endpoint. */
export function dockerPrefix(endpoint: DockerEndpoint): string {
  switch (endpoint.kind) {
    case 'local':
      return 'docker'
    case 'ssh':
      return `docker -H ssh://${q(endpoint.address)}`
    case 'wsl':
      return `wsl -d ${q(endpoint.distro)} docker`
  }
}

export function containerCommands(
  endpoint: DockerEndpoint,
  container: { name: string; running: boolean; project?: string | undefined }
): DockerLine[] {
  const d = dockerPrefix(endpoint)
  const name = q(container.name)
  const out: DockerLine[] = [
    { id: 'logs', command: `${d} logs -f --tail 200 ${name}` },
    { id: 'inspect', command: `${d} inspect ${name}` }
  ]
  if (container.running)
    out.push(
      { id: 'exec', command: `${d} exec -it ${name} sh` },
      { id: 'stats', command: `${d} stats --no-stream ${name}` },
      { id: 'restart', command: `${d} restart ${name}` },
      { id: 'stop', command: `${d} stop ${name}` }
    )
  else out.push({ id: 'start', command: `${d} start ${name}` })
  if (container.project)
    out.push({ id: 'compose-logs', command: `${d} compose -p ${q(container.project)} logs -f` })
  out.push({ id: 'remove', command: `${d} rm${container.running ? ' -f' : ''} ${name}` })
  return out
}

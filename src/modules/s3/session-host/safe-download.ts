import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/** The directory explicitly selected by the user is the trust boundary. */
export async function downloadRoot(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  return realpath(path)
}

/** Create descendants individually, rejecting directory symlinks and Windows junctions. */
export async function downloadParent(root: string, target: string): Promise<void> {
  const rel = relative(root, dirname(target))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Unsafe download destination')
  // Recheck even on subsequent calls: the root or an ancestor may have been replaced.
  if ((await realpath(root)) !== root) throw new Error('Unsafe download destination')
  let current = root
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment)
    await mkdir(current).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    })
    const entry = await lstat(current)
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error('Unsafe download destination: symbolic link or non-directory')
  }
}

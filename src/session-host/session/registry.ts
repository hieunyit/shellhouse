import type { ResolvedSessionSpec } from '@shared/stream-protocol'
import { Session, type SessionDeps, type SessionExtras, type SessionPort } from './session'

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly deps: Omit<SessionDeps, 'onEnded'>) {}

  get size(): number {
    return this.sessions.size
  }

  open(
    sessionId: string,
    spec: ResolvedSessionSpec,
    port: SessionPort,
    extras: SessionExtras = {}
  ): void {
    if (this.sessions.has(sessionId)) {
      this.deps.log('warn', `Session ${sessionId} already exists`)
      port.close()
      return
    }
    const session = new Session(
      sessionId,
      spec,
      port,
      {
        ...this.deps,
        onEnded: (id) => this.sessions.delete(id)
      },
      extras
    )
    this.sessions.set(sessionId, session)
    void session.start()
  }

  close(sessionId: string): void {
    this.sessions.get(sessionId)?.close()
  }

  /** Session đang mở (Remote Desktop trong tab dùng kết nối SSH của nó làm tunnel). */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) session.close()
  }
}

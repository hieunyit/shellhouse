/**
 * Gom input chuột trước khi gửi qua IronRDP: mỗi khung hình (requestAnimationFrame) gửi tối đa một
 * vị trí chuột (vị trí cuối) và một lượt cuộn mỗi trục (cộng dồn). Nút chuột / phím luôn đi ngay —
 * trước đó xả vị trí đang chờ để server nhận đúng thứ tự (bấm đúng chỗ con trỏ vừa tới).
 */

export interface CoalescedSink {
  /** Vị trí chuột (toạ độ client của sự kiện cuối trong khung hình). */
  move(clientX: number, clientY: number): void
  /** Cuộn: `amount` cộng dồn theo đơn vị `unit` (0 pixel, 1 dòng, 2 trang — như WheelEvent.deltaMode). */
  wheel(vertical: boolean, amount: number, unit: number): void
}

export interface FrameScheduler {
  request(cb: () => void): number
  cancel(handle: number): void
}

const animationFrames: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => {
    cancelAnimationFrame(handle)
  }
}

export class InputCoalescer {
  private move: { x: number; y: number } | null = null
  private wheelX = 0
  private wheelY = 0
  private wheelUnit = 0
  private frame: number | null = null

  constructor(
    private readonly sink: CoalescedSink,
    private readonly scheduler: FrameScheduler = animationFrames
  ) {}

  pointer(clientX: number, clientY: number): void {
    this.move = { x: clientX, y: clientY }
    this.arm()
  }

  wheel(deltaX: number, deltaY: number, unit: number): void {
    // Đổi đơn vị giữa chừng (hiếm: chuột + touchpad) → gửi phần đã gom theo đơn vị cũ trước.
    if (unit !== this.wheelUnit && (this.wheelX !== 0 || this.wheelY !== 0)) this.flushWheel()
    this.wheelUnit = unit
    this.wheelX += deltaX
    this.wheelY += deltaY
    this.arm()
  }

  /** Gửi ngay mọi thứ đang chờ (trước nút chuột / phím, khi mất focus). */
  flush(): void {
    if (this.frame !== null) {
      this.scheduler.cancel(this.frame)
      this.frame = null
    }
    const move = this.move
    this.move = null
    if (move) this.sink.move(move.x, move.y)
    this.flushWheel()
  }

  /** Bỏ mọi thứ đang chờ (ngắt phiên). */
  reset(): void {
    if (this.frame !== null) this.scheduler.cancel(this.frame)
    this.frame = null
    this.move = null
    this.wheelX = 0
    this.wheelY = 0
  }

  get pending(): boolean {
    return this.frame !== null
  }

  private flushWheel(): void {
    const { wheelX: x, wheelY: y, wheelUnit: unit } = this
    this.wheelX = 0
    this.wheelY = 0
    if (y !== 0) this.sink.wheel(true, y, unit)
    if (x !== 0) this.sink.wheel(false, x, unit)
  }

  private arm(): void {
    if (this.frame !== null) return
    this.frame = this.scheduler.request(() => {
      this.frame = null
      this.flush()
    })
  }
}

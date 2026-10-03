import { createServer, type Server, type Socket } from 'node:net'
import { TLSSocket } from 'node:tls'

/**
 * Server RDP giả cho test proxy RDCleanPath: nhận X.224 Connection Request, trả Connection Confirm,
 * rồi làm TLS (chứng chỉ tự ký cố định) và dội lại mọi byte nhận được. Không có RDP thật phía sau —
 * đủ để kiểm proxy tới hết bước RDCleanPath + chuyển byte.
 */

// Chứng chỉ EC P-256 tự ký, hạn 100 năm — CHỈ dùng cho test.
const CERTS = {
  a: {
    cert: `-----BEGIN CERTIFICATE-----
MIIBizCCATGgAwIBAgIUHPRov+6q58Eeg7B+CmwL02X0Al8wCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPZmFrZS1yZHAtYS50ZXN0MCAXDTI2MTAwMzE2MzM0MFoYDzIx
MjYwOTA5MTYzMzQwWjAaMRgwFgYDVQQDDA9mYWtlLXJkcC1hLnRlc3QwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAASf84BjnTCnqiZgt2c1VYPtUm2hEhSKl00fCh7u
khpXYifqu5NE/5tJ5DzWKo/p4luTCGnP6zDsSWRaIyi4WE1io1MwUTAdBgNVHQ4E
FgQUZLUx02sXueLIpZJlMYIVpPRvx/QwHwYDVR0jBBgwFoAUZLUx02sXueLIpZJl
MYIVpPRvx/QwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiARds89
wwxyowmdP+OjAgNs9KaAPH0gRia2MWfERC7AogIhANy/Q05XB0XQPaJZESYEBFCT
xl03CX0MzQjVppa+Qu3L
-----END CERTIFICATE-----`,
    key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgjSHOix/bbsTLev+b
zNPlndxPK3spnGIaBuIxpX4H5e6hRANCAASf84BjnTCnqiZgt2c1VYPtUm2hEhSK
l00fCh7ukhpXYifqu5NE/5tJ5DzWKo/p4luTCGnP6zDsSWRaIyi4WE1i
-----END PRIVATE KEY-----`
  },
  b: {
    cert: `-----BEGIN CERTIFICATE-----
MIIBjDCCATGgAwIBAgIUR5PbzQQO9BjiCMH327OSxMzLJxIwCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPZmFrZS1yZHAtYi50ZXN0MCAXDTI2MTAwMzE2MzM0MFoYDzIx
MjYwOTA5MTYzMzQwWjAaMRgwFgYDVQQDDA9mYWtlLXJkcC1iLnRlc3QwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAQdyMvki5kSRwf5siAjzxtuXTb8PmuZVYlAi+Z5
mLqNJAD8VHkaE4zM2KRc8LRX/Csl0VA/49qT/GVkv/BL5nUvo1MwUTAdBgNVHQ4E
FgQU00/DTdxZGj5zOPDEqz+Yg82JdwswHwYDVR0jBBgwFoAU00/DTdxZGj5zOPDE
qz+Yg82JdwswDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA2u8R
gog0jNhJNA6kQhj7YtMfkVLY7uOIFF+Et2cBi0gCIQD5KGCk4ucOVAHLo3S4Ctfh
/TE+pZp5esYCGzNL0MQB8A==
-----END CERTIFICATE-----`,
    key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfYX4IEQmRERucIYS
vKwBT+5Q464vui1ki9Fsu3gZVvChRANCAAQdyMvki5kSRwf5siAjzxtuXTb8PmuZ
VYlAi+Z5mLqNJAD8VHkaE4zM2KRc8LRX/Csl0VA/49qT/GVkv/BL5nUv
-----END PRIVATE KEY-----`
  }
} as const

export type FakeCert = keyof typeof CERTS

export interface FakeRdpOptions {
  cert?: FakeCert
  /** ssl = chọn TLS; failure = RDP_NEG_FAILURE (mã 5: cần CredSSP); legacy = không có RDP_NEG_RSP. */
  negotiation?: 'ssl' | 'failure' | 'legacy'
}

export interface FakeRdp {
  port: number
  /** Các X.224 Connection Request đã nhận. */
  requests: Buffer[]
  setCert(cert: FakeCert): void
  close(): Promise<void>
}

function confirm(kind: 'ssl' | 'failure' | 'legacy'): Buffer {
  if (kind === 'legacy') return Buffer.from([3, 0, 0, 11, 6, 0xd0, 0, 0, 0x12, 0x34, 0])
  const buf = Buffer.alloc(19)
  buf.writeUInt8(3, 0)
  buf.writeUInt16BE(19, 2)
  buf.writeUInt8(14, 4)
  buf.writeUInt8(0xd0, 5)
  buf.writeUInt16BE(0x1234, 8)
  buf.writeUInt8(kind === 'ssl' ? 0x02 : 0x03, 11)
  buf.writeUInt16LE(8, 13)
  buf.writeUInt32LE(kind === 'ssl' ? 1 : 5, 15)
  return buf
}

export async function startFakeRdp(options: FakeRdpOptions = {}): Promise<FakeRdp> {
  let cert: FakeCert = options.cert ?? 'a'
  const negotiation = options.negotiation ?? 'ssl'
  const requests: Buffer[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 4) return
      const length = buf.readUInt16BE(2)
      if (buf.length < length) return
      socket.off('data', onData)
      socket.pause()
      requests.push(buf.subarray(0, length))
      socket.write(confirm(negotiation))
      if (negotiation !== 'ssl') {
        socket.end()
        return
      }
      const tls = new TLSSocket(socket, { isServer: true, ...CERTS[cert] })
      tls.on('error', () => undefined)
      // Dội lại: client gửi gì nhận lại đúng thế (kiểm chuyển byte hai chiều qua proxy).
      tls.on('data', (data: Buffer) => {
        if (data.toString() === 'bye') tls.end()
        else tls.write(data)
      })
    }
    socket.on('data', onData)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return {
    port: address.port,
    requests,
    setCert: (next) => {
      cert = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => {
          resolve()
        })
      })
  }
}

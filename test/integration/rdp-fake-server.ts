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
  },
  /**
   * RSA 2048 tự ký, keyUsage = keyEncipherment + dataEncipherment (KHÔNG có digitalSignature) — như
   * chứng chỉ RDP mặc định của Windows. BoringSSL (Electron) từ chối ECDHE/TLS 1.3 với chứng chỉ
   * này; chỉ trao đổi khoá RSA dùng được. Tạo bằng:
   * openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj /CN=fake-rdp-legacy.test
   *   -addext keyUsage=critical,keyEncipherment,dataEncipherment -addext extendedKeyUsage=serverAuth
   */
  legacy: {
    cert: `-----BEGIN CERTIFICATE-----
MIIDRjCCAi6gAwIBAgIUEHnqJcPXjj5zhi6aWv4igJXYjscwDQYJKoZIhvcNAQEL
BQAwHzEdMBsGA1UEAwwUZmFrZS1yZHAtbGVnYWN5LnRlc3QwIBcNMjYxMDA0MDIy
MjA4WhgPMjEyNjA5MTAwMjIyMDhaMB8xHTAbBgNVBAMMFGZha2UtcmRwLWxlZ2Fj
eS50ZXN0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo0TQ57Hqgxa5
N8EYyZcVoocEpD5TxHPD4AJSmykZrQbFd2HZFziyb0n7iIrgQAYhIZPh3uzbdP25
Boyz9Fm4UG2bVrGCuYXqxYn4OWiKzaGfXdALDN2SXCcIOxKPO9BJtB0JY9pn0N5E
hmBLvkLcPwJxZjubDQPQOzNWd0ZmuszAGKMSx/126t8i+d5xHApfkMyk8gcJlDg6
zfwF350ev3Jlo/r9DBSdDu1mlMYT5R+pFPrBhrBzWS3t8x5lvZh2unKTaimA1Tvc
pLYD9TDSWHXnUis9fsy9fqhGkgFoGgwSWvQaMB+vvgNZLxN236YAYrAnMgX0/j+n
O3x/vsp5TQIDAQABo3gwdjAdBgNVHQ4EFgQUcU+eh+pMRuHqIQcnfvH4COWhjPsw
HwYDVR0jBBgwFoAUcU+eh+pMRuHqIQcnfvH4COWhjPswDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCBDAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcN
AQELBQADggEBAH9JQlO942lwl9521YlU174xihzCJz8b7vhuKdvbbsClTC27VWHl
gsDOKHOC3NGNQxR5Rxs9LWwd1FDXDJLnZr/niLwbQMtkRip6/s9UoMRSvEJb5Ixe
JobRrM7Pu9f4J1UP2kdTODT+pZBGJYYZt96u0k1HRUjm65VvUzd+hcHgq4RHVHKg
stX1813eIvRT0rwADtqHvukfgzCN4zh7Lo5zzHwXsy6sTuYrppd6YteDPunbAUBT
x1m9rHJOCr3cYwwH2wq3BclDPjr6p2nNpWdTnFCe1iRcNrlbNSHbkpsP+Ff170Iz
cu4u90RnuKF9OA3ryR9L9tG681hRJgN2Qzc=
-----END CERTIFICATE-----`,
    key: `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCjRNDnseqDFrk3
wRjJlxWihwSkPlPEc8PgAlKbKRmtBsV3YdkXOLJvSfuIiuBABiEhk+He7Nt0/bkG
jLP0WbhQbZtWsYK5herFifg5aIrNoZ9d0AsM3ZJcJwg7Eo870Em0HQlj2mfQ3kSG
YEu+Qtw/AnFmO5sNA9A7M1Z3Rma6zMAYoxLH/Xbq3yL53nEcCl+QzKTyBwmUODrN
/AXfnR6/cmWj+v0MFJ0O7WaUxhPlH6kU+sGGsHNZLe3zHmW9mHa6cpNqKYDVO9yk
tgP1MNJYdedSKz1+zL1+qEaSAWgaDBJa9BowH6++A1kvE3bfpgBisCcyBfT+P6c7
fH++ynlNAgMBAAECggEAQFZyYhM0wBKYy1U+8NWmM2U0WYqsFNqvodsYdUdFdG8a
Kni3BRUVD5DeW4iqZOBldudhFylMM7Z2DpQsp8ohPSRsFcYepwAUK2K6m9jL9ctO
UzgT2q6HqePBtRGTuvTRznWwyRX8Wgz0gOV6g4+yXewXBrvPVlod2O5akOb/vXUn
uN7LUDoFEVVMwdc0K4tozrRFb74XfadwLxmFno3lk4EavoQkA3xwAVfH0bwkxTnz
8uNDAUQLWDanWNWJCkBb8v0otk/y92YjNG7jTlsJRo8QEe8SjFrKZ9qKSbD57+MX
ZyGLtICyfRGZkXwevpRdfPSgyoaNEBCJqEgkomwbiwKBgQDTPsXZ55sITl39y4Dd
6VodJh0t5Io9/dYhK5dyAio+PV6IQAynqkSIDJYECDNe42GyUveCdhgismHk/D2n
vKYp5io5lQdKNwHB46aaidekeApY1ZXC+8gGfzxJfmea+fHQvEL+GGAtDWwcnDdl
0hrjMAUpvNDeKus1gFS/KwjKTwKBgQDF2/cpbq2CAIPNCoWK9orimDvAvlHOfUo6
H28zqqkzwDfqLnVKGaYi+nFsiTaJ8813MXBmos/AKWbOXFcgK84SfVjpuvUlxJzg
34+EF4nGW4hFuP7OUwIH51RgCuFFO9kOx84heExwcBuegA7w8Zk1j2PYI9h752v/
4r0VK96HowKBgQCoRa+7RagUdMCgg7QSkWjsIUlLHmsUuJgS8jOAaMMXszETXdn2
0UYoDcaOTa4GHyDauQZakRHmyav7iQbgEAFZDPSDy/fzoV+wAFTdc4IojErJutHC
cWhD7KSscpm7NPDwcpb265npKXD+VV43qKcsZDsopTTIVO3qP2DCq1gkNwKBgQCu
KB34VDlZUsawtnAxjy1UopcF4v/y94lce8rP+YoRyUHuWZJX9RetdjBcTrK43uad
4eCEFw8yn76kKddus+Ahmj+nDC84XUWREncq1+Unue3LITj3t0z0VASKvUjoPfOi
9PBVuaPe3G8TJrkAEEjBQkOqPnMRLPR9OcEhX4nybQKBgDlyfsybYLUkml+aAJdT
wEoxIpElvCKz8bBPK2x6/LnZqONkhj2GaEFmLhhn0XJWWfexrIdet3/Gzs56zt9p
oaOPldLto+cjSGgTg1KgY07rngvJArOYg0B55dZ4eA1XLACTyCwBQSSoxL+OKIAE
UWRTY86UmwrbVMvDuzN6v99y
-----END PRIVATE KEY-----`
  }
} as const

export type FakeCert = keyof typeof CERTS

/** Chứng chỉ (PEM) của server giả. */
export const fakeCertPem = (name: FakeCert): string => CERTS[name].cert

export interface FakeRdpOptions {
  cert?: FakeCert
  /** ssl = chọn TLS; failure = RDP_NEG_FAILURE (mã 5: cần CredSSP); legacy = không có RDP_NEG_RSP. */
  negotiation?: 'ssl' | 'failure' | 'legacy'
}

export interface FakeRdp {
  port: number
  /** Các X.224 Connection Request đã nhận. */
  requests: Buffer[]
  /** Các lượt bắt tay TLS thành công (phiên bản + bộ mã). */
  handshakes: { protocol: string; cipher: string }[]
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
  const handshakes: FakeRdp['handshakes'] = []
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
      tls.once('secure', () => {
        handshakes.push({ protocol: tls.getProtocol() ?? '', cipher: tls.getCipher().name })
      })
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
    handshakes,
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

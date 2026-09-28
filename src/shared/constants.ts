// Không import gì ở đây: file này được preload (sandbox, không có require) dùng trực tiếp.

/** Kênh main → preload mang MessagePort của một session. */
export const SESSION_PORT_CHANNEL = 'session:port'

/** Tin nhắn preload chuyển MessagePort vào main world bằng window.postMessage. */
export const PORT_MESSAGE_TYPE = 'shellhouse:session-port'

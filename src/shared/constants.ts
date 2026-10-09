// Không import gì ở đây: file này được preload (sandbox, không có require) dùng trực tiếp.

/** Kênh main → preload mang MessagePort của một session. */
export const SESSION_PORT_CHANNEL = 'session:port'

/** Tin nhắn preload chuyển MessagePort vào main world bằng window.postMessage. */
export const PORT_MESSAGE_TYPE = 'shellhouse:session-port'

/** Preload → main (đồng bộ): đường dẫn của File thật người dùng kéo thả / chọn. */
export const DROPPED_PATH_CHANNEL = 'shellhouse:dropped-path'

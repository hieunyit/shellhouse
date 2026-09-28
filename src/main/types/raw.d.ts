// Vite `?raw`: nhúng nội dung file (migration SQL) vào bundle dưới dạng chuỗi.
declare module '*?raw' {
  const content: string
  export default content
}

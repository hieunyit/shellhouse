// Electron tối giản để chụp prototype qua file:// (không cần trình duyệt Playwright).
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(() => {
  const [w, h] = (process.env.SIZE || '1440x900').split('x').map(Number);
  const win = new BrowserWindow({ width: w, height: h, useContentSize: true, show: true, frame: false, backgroundColor: '#08090a', webPreferences: { contextIsolation: true } });
  win.loadURL(process.env.URL);
});
app.on('window-all-closed', () => app.quit());

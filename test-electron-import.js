// Minimal test: does require('electron') return the API?
console.log('process.type:', process.type);
console.log('process.versions.electron:', process.versions.electron);

const electron = require('electron');
console.log('typeof electron:', typeof electron);
console.log('electron keys:', typeof electron === 'object' ? Object.keys(electron).slice(0, 10) : 'not an object');
console.log('typeof electron.app:', typeof electron.app);

if (electron.app) {
    electron.app.quit();
} else {
    console.log('FAIL: electron.app is undefined');
    process.exit(1);
}

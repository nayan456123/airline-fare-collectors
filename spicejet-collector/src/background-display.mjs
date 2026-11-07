import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Xvfb renders headed Chrome on an isolated display rather than the user's desktop.
export async function backgroundDisplay({ env = process.env } = {}) {
  if (env.SPICEJET_BACKGROUND_DISPLAY) return { display: env.SPICEJET_BACKGROUND_DISPLAY, close: async () => {} };
  if (process.platform !== 'linux') throw new Error('Background Chrome needs a Linux virtual display. Choose headless Chrome on this platform.');
  const choices = env.SPICEJET_XVFB_PATH ? [env.SPICEJET_XVFB_PATH] : ['/usr/bin/Xvfb', path.join(os.homedir(), '.cache', 'airindia-express', 'xvfb', 'usr', 'bin', 'Xvfb')];
  const executable = choices.find(filename => fs.existsSync(filename));
  if (!executable) throw new Error('Install Xvfb or set SPICEJET_XVFB_PATH to use background Chrome.');
  const child = spawn(executable, ['-displayfd', '1', '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-noreset'], { stdio:['ignore','pipe','pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', data => { errors = (errors + data).slice(-1000); });
  const close = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  };
  try {
    const display = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Virtual display startup timed out')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Virtual display stopped: ${errors}`)); });
      child.stdout.on('data', data => {
        output += data;
        const match = /^(\d+)\s*\n/.exec(output);
        if (match) { clearTimeout(timer); resolve(`:${match[1]}`); }
      });
    });
    return { display, close };
  } catch (error) { await close(); throw error; }
}

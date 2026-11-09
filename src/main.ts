import { createApp } from './bootstrap';
import { loadConfig } from './config/config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  if (config.roles.http) {
    await app.listen(config.port, '0.0.0.0');
  } else {
    await app.init(); // headless instance: consumer / publisher / pending worker only
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'fatal startup error', error: String(error) })}\n`);
  process.exit(1);
});

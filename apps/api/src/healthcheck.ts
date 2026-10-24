/** Container health check: exits 0 when the API answers on its own port (used by the Docker HEALTHCHECK). */
import { get } from 'node:http';

const port = Number(process.env.PORT ?? '8080');
const request = get({ host: '127.0.0.1', port, path: '/api/health', timeout: 4000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
request.on('timeout', () => request.destroy());
request.on('error', () => process.exit(1));

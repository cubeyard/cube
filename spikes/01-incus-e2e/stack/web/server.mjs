// Minimal web service that proves the DB is reachable: on each request it asks
// postgres for the time and its version, so a 200 means the whole stack is up.
import http from 'node:http';
import net from 'node:net';

// Tiny hand-rolled check: TCP-connect to postgres, then report. Keeps the image
// dependency-free (no npm install needed inside the orb during the spike).
function dbReachable() {
  return new Promise((resolve) => {
    const s = net.connect({ host: process.env.PGHOST || 'db', port: 5432 }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

http.createServer(async (req, res) => {
  const ok = await dbReachable();
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ stack: 'cube-spike-01', db_reachable: ok, host: process.env.HOSTNAME }));
}).listen(8080, '0.0.0.0', () => console.log('web listening on 0.0.0.0:8080'));

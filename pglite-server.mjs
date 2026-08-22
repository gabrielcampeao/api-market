import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const db = new PGlite();
await db.waitReady;

const server = new PGLiteSocketServer({ db, port: 5432, host: '127.0.0.1', maxConnections: 10 });
await server.start();
console.log('pglite listening on 127.0.0.1:5432');

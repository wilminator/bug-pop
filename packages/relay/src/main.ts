// Run the reference relay: PORT (default 8080) and an optional PATH (default: any path).
import { startRelay } from './relay';

const port = Number(process.env.PORT) || 8080;
startRelay({ port, path: process.env.RELAY_PATH || undefined, log: line => console.log(new Date().toISOString(), line) });
console.log(`Bug Pop relay listening on port ${port}`);

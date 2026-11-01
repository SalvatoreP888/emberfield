import { parentPort } from 'node:worker_threads';
import { SimulationRunner } from '../dist/simulation.worker.js';
const runner = new SimulationRunner((message, transfer) => parentPort.postMessage(message, transfer || []));
parentPort.on('message', message => runner.handle(message));

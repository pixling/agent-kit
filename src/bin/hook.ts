// The first thing a host runs (pixling-proxy). Checks the Node.js version with
// nothing else loaded, since the proxy itself needs a recent one.
import { answerIdle, recentNode } from './node-check.ts';

if (recentNode()) void import('./hook-main.ts');
else answerIdle();

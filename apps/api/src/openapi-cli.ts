/** Prints the OpenAPI document (for the web app's generated client). Needs no environment. */
import './app.js';
import { API_PREFIX } from './app.js';
import { buildOpenApi } from './http/openapi.js';

process.stdout.write(`${JSON.stringify(buildOpenApi(API_PREFIX, 'dev'), null, 2)}\n`);

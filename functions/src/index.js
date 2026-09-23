import {initializeApp, getApps} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
import {onRequest} from 'firebase-functions/v2/https';
import {defineSecret} from 'firebase-functions/params';
import {createApp} from './app.js';

if (!getApps().length) initializeApp();
const configuration = defineSecret('APP_SECRETS');
let handler;
export const api = onRequest({region: 'europe-west1', memory: '256MiB', timeoutSeconds: 120, minInstances: 0, maxInstances: 2, concurrency: 20, secrets: [configuration]}, (req, res) => {
  if (!handler) {
    let secrets;
    try { secrets = JSON.parse(configuration.value() || '{}'); }
    catch { res.status(503).json({message: 'Server configuration is invalid.'}); return; }
    handler = createApp({db: getFirestore(), auth: getAuth(), secrets});
  }
  return handler(req, res);
});

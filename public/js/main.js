import { startHost } from './host.js';
import { startViewer } from './viewer.js';

const join = location.pathname.match(/^\/v\/([\w-]{16,64})\/?$/);
if (join) startViewer(join[1]);
else startHost();

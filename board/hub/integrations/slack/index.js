// Slack connector (I3). The spec and its handlers are in spec.js; this file
// is what connectorsFor() registers once slack is offered there.
import { defineConnector } from '../connector.js';
import { spec } from './spec.js';

export default defineConnector(spec);

import { startConnection }      from './src/connection.js';
import { startBufferListeners } from './src/buffers.js';
import { dispatchAction }        from './src/actions/index.js';

startBufferListeners();
startConnection(dispatchAction);

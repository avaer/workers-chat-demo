import {zbencode} from './encoding.mjs';
import {UPDATE_METHODS} from './update-types.js';
import {parseUpdateObject, makeId} from './util.mjs';

export class IrcPlayer extends EventTarget {
  constructor() {
    super();
  }
}

export class NetworkedIrcClient extends EventTarget {
  constructor(ws, playerId = makeId()) {
    super();
    this.ws = ws;

    this.playerId = playerId;
    this.playerIds = [];
  }
  static handlesMethod(method) {
    return [
      UPDATE_METHODS.NETWORK_INIT,
      UPDATE_METHODS.JOIN,
      UPDATE_METHODS.LEAVE,
      UPDATE_METHODS.CHAT,
    ].includes(method);
  }
  async connect() {
    await new Promise((resolve, reject) => {
      resolve = (resolve => () => {
        resolve();
        _cleanup();
      })(resolve);
      reject = (reject => () => {
        reject();
        _cleanup();
      })(reject);
      
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);

      const _cleanup = () => {
        this.ws.removeEventListener('open', resolve);
        this.ws.removeEventListener('error', reject);
      };
    });

    const _waitForInitialImport = async () => {
      await new Promise((resolve, reject) => {
        const initialMessage = e => {
          if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
            const updateBuffer = e.data;
            const uint8Array = new Uint8Array(updateBuffer);
            const updateObject = parseUpdateObject(uint8Array);
            
            const {method, args} = updateObject;
            if (method === UPDATE_METHODS.NETWORK_INIT) {
              // const [playerIds] = args;
              // console.log('irc init', {playerIds});

              this.handleUpdateObject(updateObject);
    
              resolve();
              
              this.ws.removeEventListener('message', initialMessage);
            }
          }
        };
        this.ws.addEventListener('message', initialMessage);
      });
    };
    await _waitForInitialImport();

    // console.log('irc listen');
    this.ws.addEventListener('message', e => {
      // console.log('got ws data', e.data);
      if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
        const updateBuffer = e.data;
        // console.log('irc data', e.data);
        const uint8Array = new Uint8Array(updateBuffer);
        const updateObject = parseUpdateObject(uint8Array);

        const {method, args} = updateObject;
        // console.log('irc handles method', method, NetworkedIrcClient.handlesMethod(method));
        if (NetworkedIrcClient.handlesMethod(method)) {
          this.handleUpdateObject(updateObject);
        }
      }
    });
  }
  handleUpdateObject(updateObject) {
    const {method, args} = updateObject;
    // console.log('got irc event', {method, args});
    if (method === UPDATE_METHODS.NETWORK_INIT) {
      const [playerIds] = args;
      this.playerIds = playerIds;

      for (let i = 0; i < playerIds.length; i++) {
        const playerId = playerIds[i];
        this.dispatchEvent(new MessageEvent('join', {
          data: {
            playerId,
          },
        }));
      }
    } else if (method === UPDATE_METHODS.CHAT) {
      // console.log('got irc chat', {method, args});
      const [playerId, message] = args;
      const chatMessage = new MessageEvent('chat', {
        data: {
          playerId,
          message,
        },
      });
      this.dispatchEvent(chatMessage);
    } else if (method === UPDATE_METHODS.JOIN) {
      const [playerId] = args;
      this.playerIds.push(playerId);
      this.dispatchEvent(new MessageEvent('join', {
        data: {
          playerId,
        },
      }));
    } else if (method === UPDATE_METHODS.LEAVE) {
      const [playerId] = args;
      const index = this.playerIds.indexOf(playerId);
      this.playerIds.splice(index, 1);
      this.dispatchEvent(new MessageEvent('leave', {
        data: {
          playerId,
        },
      }));
    } else {
      console.warn('unhandled irc method', {method, args});
    }
  }
  sendChatMessage(message) {
    const buffer = zbencode({
      method: UPDATE_METHODS.CHAT,
      args: [
        this.playerId,
        message,
      ],
    });
    this.ws.send(buffer);
  }
}
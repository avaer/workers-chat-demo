import {zbencode, zbdecode} from './encoding.mjs';

const alignN = n => index => {
  const r = index % n;
  return r === 0 ? index : (index + n - r);
};
const align4 = alignN(4);

const parseUpdateObject = uint8Array => zbdecode(uint8Array);

function makeid(length) {
  var result           = '';
  var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for ( var i = 0; i < length; i++ ) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
 }
 return result;
}
const makeId = () => makeid(5);

function parseMessage(m) {
  const match = m.type.match(/^set\.(.+?)\.(.+?)$/);
  if (match) {
    const arrayId = match[1];
    const arrayIndexId = match[2];
    const {key, epoch, val} = m.data;
    return {
      type: 'set',
      arrayId,
      arrayIndexId,
      key,
      epoch,
      val,
    };
  } else {
    const match = m.type.match(/^add\.(.+?)$/);
    if (match) {
      const arrayId = match[1];
      const {arrayIndexId, val} = m.data;
      return {
        type: 'add',
        arrayId,
        arrayIndexId,
        val,
      };
    } else {
      const match = m.type.match(/^remove\.(.+?)$/);
      if (match) {
        const arrayId = match[1];
        const {arrayIndexId} = m.data;
        return {
          type: 'remove',
          arrayId,
          arrayIndexId,
        };
      } else {
        if (m.type === 'rollback') {
          const {arrayIndexId, key, oldEpoch, oldVal} = m.data;
          return {
            type: 'rollback',
            arrayIndexId,
            key,
            oldEpoch,
            oldVal,
          };
        } else if (m.type === 'import') {
          return {
            type: 'import',
            crdtExport: m.data.crdtExport,
          };
        } else if (m.type === 'networkinit') {
          return {
            type: 'networkinit',
            playerIds: m.data.playerIds,
          };
        } else if (m.type === 'join') {
          return {
            type: 'join',
            playerId: m.data.playerId,
          };
        } else {
          throw new Error('unrecognized message type: ' + m.type);
        } 
      }
    }
  }
}

function serializeMessage(m) {
  const parsedMessage = parseMessage(m);
  const {type, arrayId, arrayIndexId} = parsedMessage;
  switch (type) {
    case 'import': {
      const {crdtExport} = parsedMessage;
      return zbencode({
        method: UPDATE_METHODS.IMPORT,
        args: [
          crdtExport,
        ],
      });
    }
    case 'set': {
      const {key, epoch, val} = m.data;
      return zbencode({
        method: UPDATE_METHODS.SET,
        args: [
          arrayId,
          arrayIndexId,
          key,
          epoch,
          val,
        ],
      });
    }
    case 'add': {
      const {arrayIndexId, val} = m.data;
      return zbencode({
        method: UPDATE_METHODS.ADD,
        args: [
          arrayId,
          arrayIndexId,
          val,
        ],
      });
    }
    case 'remove': {
      const {arrayIndexId} = m.data;
      return zbencode({
        method: UPDATE_METHODS.REMOVE,
        args: [
          arrayId,
          arrayIndexId,
        ],
      });
    }
    case 'rollback': {
      const {arrayIndexId, key, oldEpoch, oldVal} = m.data;
      return zbencode({
        method: UPDATE_METHODS.ROLLBACK,
        args: [
          arrayIndexId,
          key,
          oldEpoch,
          oldVal,
        ],
      });
    }
    case 'networkinit': {
      const {playerIds} = message.data;
      return zbencode({
        method: UPDATE_METHODS.NETWORK_INIT,
        args: [
          playerIds,
        ],
      });
    }
    case 'join': {
      const {playerId} = m.data;
      return zbencode({
        method: UPDATE_METHODS.JOIN,
        args: [
          playerId,
        ],
      });
      // throw new Error('not implemented');
    }
    default: {
      console.warn('unrecognized message type', type);
      throw new Error('unrecognized message type: ' + type);
    }
  }
}

export {
  alignN,
  align4,
  parseUpdateObject,
  makeId,
  parseMessage,
  serializeMessage,
};
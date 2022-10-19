import {UPDATE_METHODS} from './update-types.js';
import {parseUpdateObject, makeId} from './util.mjs';
import {ensureAudioContext, getAudioContext} from './wsrtc/ws-audio-context.js';
import {WsMediaStreamAudioReader, WsAudioEncoder, WsAudioDecoder} from './wsrtc/ws-codec.js';
import {getEncodedAudioChunkBuffer, getAudioDataBuffer} from './wsrtc/ws-util.js';

function createAudioOutputFromStream(socket) {
  const audioContext = getAudioContext();

  const audioWorkletNode = new AudioWorkletNode(
    audioContext,
    'ws-output-worklet'
  );

  const audioDecoder = new WsAudioDecoder({
    output: (data) => {
      data = getAudioDataBuffer(data);
      audioWorkletNode.port.postMessage(data, [data.buffer]);
    },
  });

  /* if (!this.avatar.isAudioEnabled()) {
    this.avatar.setAudioEnabled(true);
  } */

  // audioWorkletNode.connect(this.avatar.getAudioInput());
  
  const result = new EventTarget();
  result.outputNode = audioWorkletNode;
  result.audioDecoder = audioDecoder;

  socket.addEventListener('data', e => {
    const {data} = e;
    // console.log('decode data', data);
    audioDecoder.decode(data);
  });

  return result;

  /* return {
    outputNode: audioWorkletNode,
    audioDecoder,
  }; */
}

const stopMediaStream = mediaStream => {
  // stop all tracks
  for (const track of mediaStream.getTracks()) {
    track.stop();
  }
};
async function createMicrophoneSource(playerId = makeId()) {
  const audioContext = await ensureAudioContext();
  audioContext.resume();
  
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
  });

  const audioReader = new WsMediaStreamAudioReader(mediaStream);

  const fakeWs = new EventTarget();
  const _renderOutput = async () => {
    const result = createAudioOutputFromStream(fakeWs);
    const {
      outputNode,
      audioDecoder,
    } = result;
    const audioContext = getAudioContext();
    outputNode.connect(audioContext.destination);
  };
  _renderOutput();

  const muxAndSend = encodedChunk => {
    const {type, timestamp} = encodedChunk;
    const data = getEncodedAudioChunkBuffer(encodedChunk);

    fakeWs.dispatchEvent(new MessageEvent('data', {
      data,
    }));

    /* sendAudioMessage(
      UPDATE_METHODS.AUDIO,
      playerId,
      type,
      timestamp,
      data,
    ); */
  };
  function onEncoderError(err) {
    console.warn('encoder error', err);
  }
  const audioEncoder = new WsAudioEncoder({
    output: muxAndSend,
    error: onEncoderError,
  });

  async function readAndEncode() {
    const result = await audioReader.read();
    if (!result.done) {
      audioEncoder.encode(result.value);
      readAndEncode();
    }
  }
  readAndEncode();

  return {
    mediaStream,
    audioReader,
    audioEncoder,
    destroy() {
      // console.log('media stream destroy');
      stopMediaStream(mediaStream);
      audioReader.cancel();
      audioEncoder.close();
    },
  };
}
if (typeof window !== 'undefined') {
  window.createMicrophoneSource = ((createMicrophoneSource) => async function() {
    const result = await createMicrophoneSource.apply(this, arguments);
    window.cancelMicrophoneSource = () => {
      result.destroy();
      window.cancelMicrophoneSource = null;
    };
  })(createMicrophoneSource);
  window.cancelMicrophoneSource = null;
}

export class NetworkedAudioClient extends EventTarget {
  constructor(ws, playerId = makeId()) {
    super();
    this.ws = ws;
    this.playerId = playerId;
  }
  static handlesMethod(method) {
    return [
      UPDATE_METHODS.AUDIO_START,
      UPDATE_METHODS.AUDIO,
      UPDATE_METHODS.AUDIO_END,
    ].includes(method);
  }
  async enableMic() {
    await window.createMicrophoneSource();
  }
  disableMic() {
    window.cancelMicrophoneSource();
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
          if (e.data instanceof ArrayBuffer) {
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
      if (e.data instanceof ArrayBuffer) {
        const updateBuffer = e.data;
        // console.log('irc data', e.data);
        const uint8Array = new Uint8Array(updateBuffer);
        const updateObject = parseUpdateObject(uint8Array);

        const {method, args} = updateObject;
        // console.log('irc handles method', method, NetworkedIrcClient.handlesMethod(method));
        if (NetworkedAudioClient.handlesMethod(method)) {
          this.handleUpdateObject(updateObject);
        }
      }
    });
  }
  handleUpdateObject(updateObject) {
    const {method, args} = updateObject;
    // console.log('got irc event', {method, args});
    if (method === UPDATE_METHODS.AUDIO_START) {
      const [playerId] = args;

      this.dispatchEvent(new MessageEvent('audiostart', {
        data: {
          playerId,
        },
      }));
    } else if (method === UPDATE_METHODS.AUDIO) {
      // console.log('got irc chat', {method, args});
      const [playerId, buffer] = args;
      const audioMessage = new MessageEvent('audio', {
        data: {
          playerId,
          buffer,
        },
      });
      this.dispatchEvent(audioMessage);
    } else if (method === UPDATE_METHODS.AUDIO_END) {
      // console.log('got irc chat', {method, args});
      const [playerId] = args;
      const audioEndMessage = new MessageEvent('audioend', {
        data: {
          playerId,
        },
      });
      this.dispatchEvent(audioEndMessage);
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
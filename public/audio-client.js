import {UPDATE_METHODS} from './update-types.js';
import {parseUpdateObject, makeId} from './util.mjs';
import {zbencode, zbdecode} from "./encoding.mjs";
import {ensureAudioContext, getAudioContext} from './wsrtc/ws-audio-context.js';
import {WsMediaStreamAudioReader, WsAudioEncoder, WsAudioDecoder} from './wsrtc/ws-codec.js';
import {getEncodedAudioChunkBuffer, getAudioDataBuffer} from './wsrtc/ws-util.js';

function createAudioOutputStream() {
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

  return {
    outputNode: audioWorkletNode,
    audioDecoder,
    write(data) {
      audioDecoder.decode(data);
    },
    close() {
      audioWorkletNode.disconnect();
      audioDecoder.close();
    },
  }
}

const stopMediaStream = mediaStream => {
  // stop all tracks
  for (const track of mediaStream.getTracks()) {
    track.stop();
  }
};
async function createMicrophoneSource() {
  const audioContext = await ensureAudioContext();
  audioContext.resume();
  
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
  });

  const audioReader = new WsMediaStreamAudioReader(mediaStream);

  const fakeWs = new EventTarget();
  /* const _renderOutput = async () => {
    const result = createAudioOutputFromStream(fakeWs);
    result.outputNode.connect(audioContext.destination);
  };
  _renderOutput(); */

  const muxAndSend = encodedChunk => {
    const {type, timestamp} = encodedChunk;
    const data = getEncodedAudioChunkBuffer(encodedChunk);

    fakeWs.dispatchEvent(new MessageEvent('data', {
      data,
    }));
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
    outputSocket: fakeWs,
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

export class NetworkedAudioClient extends EventTarget {
  constructor(playerId = makeId()) {
    super();
    
    this.playerId = playerId;

    this.audioStreams = new Map();

    this.ws = null;

    if (typeof window !== 'undefined') {
      window.startAudio = async () => {
        const microphone = await createMicrophoneSource();

        microphone.outputSocket.addEventListener('data', e => {
          // console.log('send mic data', e.data.byteLength);
          this.ws.send(zbencode({
            method: UPDATE_METHODS.AUDIO,
            args: [
              this.playerId,
              e.data,
            ],
          }));
        });

        window.stopAudio = () => {
          this.ws.send(zbencode({
            method: UPDATE_METHODS.AUDIO_END,
            args: [
              this.playerId,
            ],
          }));
          
          microphone.destroy();

          window.stopAudio = null;
        };
      };
      window.stopAudio = null;
    }
  }
  static handlesMethod(method) {
    return [
      // UPDATE_METHODS.AUDIO_START,
      UPDATE_METHODS.AUDIO,
      UPDATE_METHODS.AUDIO_END,
    ].includes(method);
  }
  async enableMic() {
    await window.startAudio();
  }
  disableMic() {
    window.stopAudio();
  }
  async connect(ws) {
    this.ws = ws;

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

    /* const _waitForInitialImport = async () => {
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
    await _waitForInitialImport(); */

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
        if (NetworkedAudioClient.handlesMethod(method)) {
          this.handleUpdateObject(updateObject);
        }
      }
    });
  }
  handleUpdateObject(updateObject) {
    const {method, args} = updateObject;
    // console.log('got audio message event', {method, args});
    if (method === UPDATE_METHODS.AUDIO) {
      // console.log('got irc chat', {method, args});
      const [playerId, data] = args;

      let audioStream = this.audioStreams.get(playerId);
      if (!audioStream) {
        const outputStream = createAudioOutputStream();
        outputStream.outputNode.connect(getAudioContext().destination);
        this.audioStreams.set(playerId, outputStream);
        // console.log('unknown audio event', playerId);
        // debugger;
        // throw new Error('no audio stream for player id: ' + playerId);
        audioStream = outputStream;

        this.dispatchEvent(new MessageEvent('audiostreamstart', {
          data: {
            playerId,
          },
        }));
      }
      // console.log('receive mic data', data.byteLength);
      audioStream.write(data);
    } else if (method === UPDATE_METHODS.LEAVE || method === UPDATE_METHODS.AUDIO_END) {
      // console.log('got leave', {method, args});
      const [playerId] = args;

      const audioStream = this.audioStreams.get(playerId);
      if (audioStream) {
        // console.log('unknown audio ended', playerId);
        // debugger;
        // throw new Error('no audio stream for player id: ' + playerId);
        audioStream.close();
        this.audioStreams.delete(playerId);

        this.dispatchEvent(new MessageEvent('audiostreamend', {
          data: {
            playerId,
          },
        }));
      }
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
      console.warn('unhandled irc method', updateObject);
      debugger;
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